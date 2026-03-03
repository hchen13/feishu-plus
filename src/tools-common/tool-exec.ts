import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  listEnabledFeishuAccounts,
  resolveFeishuAccount,
} from "../accounts.js";
import { createFeishuClient } from "../client.js";
import { resolveToolsConfig } from "../tools-config.js";
import { getCurrentFeishuToolContext } from "./tool-context.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "../types.js";

export type FeishuToolFlag = keyof Required<FeishuToolsConfig>;

/**
 * Minimal subset of OpenClawPluginToolContext used by account routing.
 * OpenClaw passes this to tool factories at call time via the factory pattern.
 * (OpenClawPluginToolContext is not in the public SDK export, so we define the shape we need.)
 */
type FeishuToolFactoryContext = {
  /** The agent's bound accountId for the current channel (from OpenClaw bindings config). */
  agentAccountId?: string;
  /** The current agent's ID. */
  agentId?: string;
  /** The current session key. */
  sessionKey?: string;
  [key: string]: unknown;
};

export function hasFeishuToolEnabledForAnyAccount(
  cfg: ClawdbotConfig,
  requiredTool?: FeishuToolFlag,
): boolean {
  // Tool registration is global (one definition), so we only need to know whether
  // at least one enabled account can use the tool.
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    return false;
  }
  if (!requiredTool) {
    return true;
  }
  return accounts.some((account) => resolveToolsConfig(account.config.tools)[requiredTool]);
}

/**
 * Resolve which Feishu account a tool should execute as.
 *
 * Resolution order:
 * 1. Message-driven path: AsyncLocalStorage has explicit accountId from the inbound message handler
 * 2. Non-message path: agentAccountId provided by OpenClaw's tool factory context (agent's bound account)
 * 3. Bindings fallback: look up cfg.bindings for the agentId's feishu accountId (runtime metadata only,
 *    no IDENTITY/BOOTSTRAP text dependency). Only channel=feishu bindings with accountId are examined.
 *    Multiple distinct accountIds → explicit error (no guessing). Zero matches → explicit error.
 * 4. No context available → explicit error (no silent fallback to prevent account misrouting)
 *
 * @param cfg - OpenClaw config
 * @param agentAccountId - from FeishuToolFactoryContext.agentAccountId (factory path)
 * @param agentId - from FeishuToolFactoryContext.agentId (used for level-3 bindings fallback)
 */
export function resolveToolAccount(
  cfg: ClawdbotConfig,
  agentAccountId?: string,
  agentId?: string,
): ResolvedFeishuAccount {
  const context = getCurrentFeishuToolContext();

  // 1. Message-driven path: ALS has explicit accountId injected by bot.ts
  if (context?.channel === "feishu" && context.accountId) {
    console.log(`[feishu:routing] level=1 (ALS) accountId="${context.accountId}" sessionKey="${context.sessionKey ?? ""}"`);
    return resolveFeishuAccount({ cfg, accountId: context.accountId });
  }

  // 2. Non-message path: agent factory context provides the agent's bound Feishu accountId
  if (agentAccountId) {
    console.log(`[feishu:routing] level=2 (agentAccountId) accountId="${agentAccountId}" agentId="${agentId ?? ""}"`);
    return resolveFeishuAccount({ cfg, accountId: agentAccountId });
  }

  // 3. Bindings fallback: use agentId to look up cfg.bindings for feishu accountId.
  //    Pure runtime metadata — no IDENTITY/BOOTSTRAP text, no default fallback.
  //    Multiple distinct accountIds → explicit error (no guessing allowed).
  //    Zero matches → explicit error with fix instructions.
  if (agentId) {
    const bindings = cfg.bindings ?? [];
    const feishuBindings = bindings.filter(
      (b) => b.agentId === agentId && b.match.channel === "feishu" && b.match.accountId,
    );
    const uniqueAccountIds = [...new Set(feishuBindings.map((b) => b.match.accountId!))];

    if (uniqueAccountIds.length === 0) {
      throw new Error(
        `[feishu:routing] level=3 (bindings-fallback) MISS: no feishu binding with accountId found ` +
        `for agent "${agentId}" in config.bindings. ` +
        `Fix: add { agentId: "${agentId}", match: { channel: "feishu", accountId: "<your-feishu-account>" } } ` +
        `to the top-level 'bindings' array in your OpenClaw config.`,
      );
    }

    if (uniqueAccountIds.length > 1) {
      throw new Error(
        `[feishu:routing] level=3 (bindings-fallback) AMBIGUOUS: agent "${agentId}" matched ` +
        `${uniqueAccountIds.length} distinct feishu accountIds: [${uniqueAccountIds.join(", ")}]. ` +
        `Ensure only one feishu accountId binding exists for this agent, ` +
        `or use the asAccountId parameter for explicit delegation.`,
      );
    }

    const resolvedAccountId = uniqueAccountIds[0]!;
    console.log(`[feishu:routing] level=3 (bindings-fallback) agentId="${agentId}" → accountId="${resolvedAccountId}"`);
    return resolveFeishuAccount({ cfg, accountId: resolvedAccountId });
  }

  // 4. No context at all → explicit error (no silent fallback).
  // This prevents account misrouting (e.g., agent A's tool call silently using agent B's bot).
  throw new Error(
    "[feishu:routing] no account context available (ALS=miss, agentAccountId=miss, agentId=miss). " +
    "Tool must be called from a Feishu message handler (accountId via AsyncLocalStorage) " +
    "or from an agent with a bound Feishu accountId (via OpenClaw bindings config). " +
    "Fix: add { agentId: '<agent-id>', match: { channel: 'feishu', accountId: '<account>' } } " +
    "to the top-level 'bindings' array in your OpenClaw config.",
  );
}

/**
 * Check if a calling account is authorized to operate as a different account (asAccountId delegation).
 *
 * Permission is granted when the target account's config lists the caller in `allowedSupervisors`.
 * Use "*" in `allowedSupervisors` to allow any account to delegate.
 */
function checkSupervisorPermission(params: {
  cfg: ClawdbotConfig;
  callingAccountId: string;
  targetAccountId: string;
}): void {
  const { cfg, callingAccountId, targetAccountId } = params;
  if (callingAccountId === targetAccountId) return; // same account, no delegation needed

  const targetAccount = resolveFeishuAccount({ cfg, accountId: targetAccountId });
  const supervisors: string[] = (targetAccount.config as any).allowedSupervisors ?? [];

  const allowed = supervisors.some(
    (s) => s === "*" || s === callingAccountId,
  );

  if (!allowed) {
    throw new Error(
      `Feishu: account "${callingAccountId}" is not authorized to operate as "${targetAccountId}". ` +
      `To grant access, add "${callingAccountId}" to the target account's allowedSupervisors list: ` +
      `channels.feishu.accounts.${targetAccountId}.allowedSupervisors: ["${callingAccountId}"]`,
    );
  }
}

/**
 * Execute a Feishu tool with account resolution, authorization, and result enrichment.
 *
 * Account resolution order:
 * 1. ALS message context (from inbound message dispatch)
 * 2. agentAccountId from tool factory context (agent's bound Feishu account)
 * 3. Bindings fallback: cfg.bindings lookup by agentId (channel=feishu only, single-match required)
 * 4. Error if none available (no silent fallback)
 *
 * Features:
 * - Supports `asAccountId` delegation with supervisor permission check
 * - Injects `_effectiveAccountId` into tool result JSON for transparency
 *
 * @param params.api - Plugin API instance
 * @param params.toolName - Tool name for error messages
 * @param params.requiredTool - Optional tool capability flag to check
 * @param params.agentAccountId - From FeishuToolFactoryContext.agentAccountId
 * @param params.agentId - From FeishuToolFactoryContext.agentId (used for bindings fallback)
 * @param params.asAccountId - Explicit account override (requires supervisor permission)
 * @param params.run - Tool implementation callback
 */
export async function withFeishuToolClient<T>(params: {
  api: OpenClawPluginApi;
  toolName: string;
  requiredTool?: FeishuToolFlag;
  /** Account ID from OpenClaw's tool factory context (agent's bound Feishu account) */
  agentAccountId?: string;
  /** Agent ID from OpenClaw's tool factory context (used for bindings fallback) */
  agentId?: string;
  /** Explicit account override for supervisor delegation */
  asAccountId?: string;
  run: (args: { client: Lark.Client; account: ResolvedFeishuAccount }) => Promise<T>;
}): Promise<T> {
  const { api, agentAccountId, agentId, asAccountId } = params;

  if (!api.config) {
    throw new Error("Feishu config is not available");
  }

  // Resolve the calling account (who is actually making this tool call)
  const callingAccount = resolveToolAccount(api.config, agentAccountId, agentId);

  // Resolve the effective account (may differ if asAccountId delegation is requested)
  let account = callingAccount;
  if (asAccountId && asAccountId !== callingAccount.accountId) {
    checkSupervisorPermission({
      cfg: api.config,
      callingAccountId: callingAccount.accountId,
      targetAccountId: asAccountId,
    });
    account = resolveFeishuAccount({ cfg: api.config, accountId: asAccountId });
  }

  if (!account.enabled) {
    throw new Error(`Feishu account "${account.accountId}" is disabled`);
  }
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" is not configured`);
  }

  if (params.requiredTool) {
    // Enforce per-account tool toggles, even though the tool is registered globally.
    const toolsCfg = resolveToolsConfig(account.config.tools);
    if (!toolsCfg[params.requiredTool]) {
      throw new Error(
        `Feishu tool "${params.toolName}" is disabled for account "${account.accountId}"`,
      );
    }
  }

  const client = createFeishuClient(account);

  let result: T;
  try {
    result = await params.run({ client, account });
  } catch (err) {
    // Re-throw with effective account context so callers can include it in error responses.
    const msg = err instanceof Error ? err.message : String(err);
    const delegation = callingAccount.accountId !== account.accountId
      ? ` (via delegation from "${callingAccount.accountId}")`
      : "";
    throw Object.assign(
      new Error(`[feishu:${account.accountId}${delegation}] ${msg}`),
      { _effectiveAccountId: account.accountId, _callingAccountId: callingAccount.accountId },
    );
  }

  // Inject _effectiveAccountId into the model-visible text output for transparency.
  // This helps agents and users know which Feishu identity was used for the operation.
  injectEffectiveAccountId(result, account.accountId, callingAccount.accountId !== account.accountId ? callingAccount.accountId : undefined);

  return result;
}

/**
 * Inject _effectiveAccountId (and optionally _callingAccountId) into a tool result's JSON content.
 * Only modifies results that have the standard AgentToolResult shape: { content: [{type:"text", text: JSON}] }
 */
function injectEffectiveAccountId(result: unknown, effectiveAccountId: string, callingAccountId?: string): void {
  if (!result || typeof result !== "object") return;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.content)) return;

  const textItem = r.content.find(
    (c: unknown): c is { type: string; text: string } =>
      typeof c === "object" && c !== null && (c as any).type === "text" && typeof (c as any).text === "string",
  );
  if (!textItem) return;

  try {
    const parsed = JSON.parse(textItem.text);
    parsed._effectiveAccountId = effectiveAccountId;
    if (callingAccountId) {
      parsed._callingAccountId = callingAccountId;
    }
    textItem.text = JSON.stringify(parsed, null, 2);
  } catch {
    // Non-JSON content – append as a comment line for model visibility
    textItem.text += `\n// effectiveAccountId: ${effectiveAccountId}`;
  }
}

/**
 * Create an OpenClaw tool factory that auto-injects agentAccountId and agentId from the tool call context.
 *
 * OpenClaw calls this factory each time a tool is invoked, passing the current agent's context
 * (including its bound Feishu accountId and agentId). The factory returns the tool object with both
 * values captured in the closure for account resolution.
 *
 * Usage:
 * ```typescript
 * api.registerTool(
 *   makeFeishuToolFactory((agentAccountId, agentId) => ({
 *     name: "my_tool",
 *     label: "My Tool",
 *     parameters: MySchema,
 *     execute(_toolCallId, params) {
 *       return withFeishuToolClient({ api, toolName: "my_tool", agentAccountId, agentId, run: ... });
 *     }
 *   }))
 * );
 * ```
 *
 * For asAccountId delegation support, extract it from params:
 * ```typescript
 * execute(_toolCallId, params) {
 *   const { asAccountId, ...rest } = params as any;
 *   return withFeishuToolClient({ api, toolName: "my_tool", agentAccountId, agentId, asAccountId, run: ... });
 * }
 * ```
 */
export function makeFeishuToolFactory<T extends object>(
  createTool: (agentAccountId: string | undefined, agentId: string | undefined) => T,
): (ctx: FeishuToolFactoryContext) => T {
  return (ctx: FeishuToolFactoryContext) => createTool(ctx.agentAccountId, ctx.agentId);
}
