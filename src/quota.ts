/**
 * Feishu quota system: group-based daily usage limits and model restrictions.
 *
 * Config shape (under channels.feishu):
 *
 *   quotas:
 *     blockMessage: "Daily quota exceeded."
 *     modelBlockMessage: "Model not available for your account."
 *     groups:
 *       - name: free
 *         members: ["@free_users"]
 *         dailyLimit: 10
 *         models: ["haiku"]
 *       - name: pro
 *         members: ["@pro_users"]
 *         dailyLimit: 100
 *         models: "*"
 *
 * Matching rules:
 * - groups are evaluated top-to-bottom; first match wins
 * - members supports @groupName references, direct IDs, and "*" wildcard
 * - if no quotas config is present, no enforcement occurs
 * - dailyLimit of -1 or undefined = unlimited
 * - models of "*" or undefined = no model restriction
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { normalizeFeishuAllowEntry } from "./policy.js";

// ── Types ──

export interface QuotaGroupConfig {
  name?: string;
  members: Array<string | number>;
  dailyLimit?: number; // -1 or undefined = unlimited
  models?: string[] | "*"; // "*" or undefined = no restriction
}

export interface QuotaConfig {
  blockMessage?: string;
  modelBlockMessage?: string;
  groups?: QuotaGroupConfig[];
}

// ── Member resolution (mirrors command-control.ts pattern) ──

/**
 * Resolve @groupName references in a members array to actual ID lists.
 */
function resolveMembers(
  userGroups: Record<string, Array<string | number>>,
  members: Array<string | number>,
  groupName: string,
): string[] {
  const result: string[] = [];
  for (const member of members) {
    const s = String(member).trim();
    if (s.startsWith("@")) {
      const refName = s.slice(1);
      if (!Object.prototype.hasOwnProperty.call(userGroups, refName)) {
        console.warn(
          `[feishu/quota] group "${groupName}" references @${refName} which is not defined in userGroups`,
        );
      }
      const resolved = userGroups[refName] ?? [];
      result.push(
        ...resolved
          .map((id) => normalizeFeishuAllowEntry(String(id)))
          .filter(Boolean),
      );
    } else {
      const normalized = normalizeFeishuAllowEntry(s);
      if (normalized) result.push(normalized);
    }
  }
  return result;
}

/**
 * Check if any of the sender's IDs match the resolved members list.
 */
function senderMatchesMembers(resolvedMembers: string[], senderIds: string[]): boolean {
  if (resolvedMembers.includes("*")) return true;
  const normalized = senderIds.map((id) => normalizeFeishuAllowEntry(id)).filter(Boolean);
  return resolvedMembers.some((m) => normalized.includes(m));
}

// ── Core functions ──

/**
 * Find the first quota group that matches the sender.
 * Returns undefined if no group matches (no quota enforcement).
 */
export function resolveQuotaGroup(
  senderIds: string[],
  groups: QuotaGroupConfig[],
  userGroups: Record<string, Array<string | number>>,
): QuotaGroupConfig | undefined {
  for (const group of groups) {
    const resolvedMembers = resolveMembers(userGroups, group.members, group.name ?? "unnamed");
    if (senderMatchesMembers(resolvedMembers, senderIds)) {
      return group;
    }
  }
  return undefined;
}

/**
 * Check whether a model entry matches a full model ID.
 *
 * Matching rules (in priority order):
 * 1. Exact: case-insensitive full string match against modelId
 * 2. Alias: case-insensitive match against the model's configured alias
 *
 * No substring fallback — unrecognized entries are treated as no-match.
 */
function modelEntryMatches(
  entry: string,
  modelId: string,
  configuredModels?: Record<string, { alias?: string }>,
): boolean {
  const entryLower = entry.toLowerCase();

  // Exact full ID match
  if (modelId.toLowerCase() === entryLower) return true;

  // Alias match
  if (configuredModels) {
    const modelCfg = configuredModels[modelId];
    if (modelCfg?.alias && modelCfg.alias.toLowerCase() === entryLower) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether a model is allowed under a quota group's model restriction.
 *
 * - undefined or "*" → always allowed
 * - Array → checked via modelEntryMatches (exact ID > alias, no substring)
 */
export function checkModelAllowed(
  models: string[] | "*" | undefined,
  agentModel: string | undefined,
  configuredModels?: Record<string, { alias?: string }>,
): boolean {
  if (models === undefined || models === "*") return true;
  if (!agentModel) return true;
  return models.some((m) => modelEntryMatches(m, agentModel, configuredModels));
}

/**
 * Given an allowed model list and the full models config, find the best
 * full model ID that matches any allowed entry.
 *
 * Picks the last match in config iteration order
 * (convention: more capable models listed later).
 *
 * Returns undefined if no match found.
 */
export function resolveModelDowngrade(
  allowedModels: string[],
  configuredModels: Record<string, { alias?: string }> | undefined,
): string | undefined {
  if (!configuredModels) return undefined;
  let best: string | undefined;
  for (const [modelId] of Object.entries(configuredModels)) {
    if (allowedModels.some((m) => modelEntryMatches(m, modelId, configuredModels))) {
      best = modelId;
    }
  }
  return best;
}

// ── Per-session model override cache ──

const modelOverrides = new Map<string, string>();

export function setModelOverride(sessionKey: string, modelId: string): void {
  modelOverrides.set(sessionKey, modelId);
}

export function consumeModelOverride(sessionKey: string): string | undefined {
  const override = modelOverrides.get(sessionKey);
  // Don't delete — the override should persist for the session lifetime
  // so every turn uses the downgraded model, not just the first.
  return override;
}

export function clearModelOverride(sessionKey: string): void {
  modelOverrides.delete(sessionKey);
}

// ── Daily quota counter with persistence ──

type DailyData = Record<string, Record<string, number>>;

export class DailyQuotaCounter {
  private data: Map<string, number> = new Map();
  private currentDate: string;
  private readonly persistPath: string;

  constructor(accountId: string) {
    this.currentDate = todayKey();
    this.persistPath = path.join(
      os.homedir(),
      ".openclaw",
      "state",
      "feishu",
      "quotas",
      accountId,
      "daily.json",
    );
    this.loadFromDisk();
  }

  /**
   * Check if the sender is within their daily limit.
   */
  check(
    senderId: string,
    limit: number,
  ): { allowed: boolean; used: number; limit: number } {
    this.rolloverIfNeeded();
    const key = `${this.currentDate}:${senderId}`;
    const used = this.data.get(key) ?? 0;
    return { allowed: used < limit, used, limit };
  }

  /**
   * Increment the sender's usage count for today.
   */
  increment(senderId: string): void {
    this.rolloverIfNeeded();
    const key = `${this.currentDate}:${senderId}`;
    this.data.set(key, (this.data.get(key) ?? 0) + 1);
    this.persistToDisk();
  }

  private rolloverIfNeeded(): void {
    const today = todayKey();
    if (today !== this.currentDate) {
      // Clean previous day's data
      const keysToDelete: string[] = [];
      for (const key of this.data.keys()) {
        if (!key.startsWith(today + ":")) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        this.data.delete(key);
      }
      this.currentDate = today;
    }
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      const parsed: DailyData = JSON.parse(raw);
      const today = this.currentDate;
      const todayData = parsed[today];
      if (todayData && typeof todayData === "object") {
        for (const [senderId, count] of Object.entries(todayData)) {
          if (typeof count === "number" && count > 0) {
            this.data.set(`${today}:${senderId}`, count);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt; start fresh
    }
  }

  private persistToDisk(): void {
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });

      // Build output: only today's data
      const today = this.currentDate;
      const todayData: Record<string, number> = {};
      const prefix = today + ":";
      for (const [key, count] of this.data.entries()) {
        if (key.startsWith(prefix)) {
          todayData[key.slice(prefix.length)] = count;
        }
      }

      const output: DailyData = { [today]: todayData };
      fs.writeFileSync(this.persistPath, JSON.stringify(output, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[feishu/quota] failed to persist quota data: ${String(err)}`);
    }
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Counter cache (one per account) ──

const counterCache = new Map<string, DailyQuotaCounter>();

export function getOrCreateQuotaCounter(accountId: string): DailyQuotaCounter {
  let counter = counterCache.get(accountId);
  if (!counter) {
    counter = new DailyQuotaCounter(accountId);
    counterCache.set(accountId, counter);
  }
  return counter;
}
