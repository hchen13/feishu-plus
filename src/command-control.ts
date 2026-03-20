/**
 * Feishu command control: group-based slash command permission system.
 *
 * Config shape (under channels.feishu):
 *
 *   userGroups:
 *     admin: ["ou_xxx", "ou_yyy"]
 *     tech:  ["ou_dept_tech"]
 *
 *   commandControl:
 *     blockMessage: "你没有权限使用该命令"
 *     groups:
 *       - name: admin
 *         members: ["@admin"]
 *         commands: "*"              # allow all (including future commands)
 *       - name: tech
 *         members: ["@tech"]
 *         except: ["/dangerous"]    # allow all except listed
 *       - name: default
 *         members: ["*"]
 *         commands: ["/new", "/help"] # allowlist only
 *
 * Matching rules:
 * - groups are evaluated top-to-bottom; first match wins
 * - members supports @groupName references, raw ou_xxx IDs, and "*" wildcard
 * - if no commandControl is configured, all commands are allowed (backward compatible)
 * - if sender matches no group, a built-in safe default applies:
 *   only /status, /new, /reset are permitted
 * - commands and except are mutually exclusive on a single group rule
 */

import { normalizeFeishuAllowEntry } from "./policy.js";

export type CommandControlGroup = {
  name: string;
  members: Array<string | number>;
  /** "*" = allow all; string[] = allowlist. Mutually exclusive with except. */
  commands?: "*" | string[];
  /** denylist: allow all except these. Mutually exclusive with commands. */
  except?: string[];
};

export type CommandControlConfig = {
  blockMessage?: string;
  groups?: CommandControlGroup[];
};

export type CommandControlResult =
  | { allowed: true; matchedGroup?: string }
  | { allowed: false; matchedGroup?: string; blockMessage?: string };

/**
 * Resolve @groupName references in a members array to actual ID lists.
 * Warns when a @groupName reference has no corresponding entry in userGroups.
 * Non-reference entries are normalized via normalizeFeishuAllowEntry.
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
          `[feishu/commandControl] group "${groupName}" references @${refName} which is not defined in userGroups`,
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

/**
 * Check if a command is permitted under a group's rule.
 *
 * - except defined   → denylist mode: allow unless command is in the list
 * - commands = "*"   → allow all
 * - commands = [...] → allowlist mode: allow only if command is in the list
 * - neither defined  → allow all (permissive default)
 */
function isCommandAllowedInGroup(group: CommandControlGroup, command: string): boolean {
  const cmd = command.toLowerCase();
  if (group.except !== undefined) {
    return !group.except.map((c) => c.toLowerCase()).includes(cmd);
  }
  if (group.commands === "*") {
    return true;
  }
  if (Array.isArray(group.commands)) {
    return group.commands.map((c) => c.toLowerCase()).includes(cmd);
  }
  return true;
}

/**
 * Extract the slash command token from a (already-normalized) message body.
 * Returns null if the message is not a command.
 */
export function extractCommandToken(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = trimmed.split(/\s+/)[0].toLowerCase();
  // Bare "/" with no command name is not a meaningful command token.
  if (token === "/") return null;
  return token;
}

/**
 * Check whether the sender is allowed to execute the command in the given message.
 *
 * Returns { allowed: true } when:
 * - commandControl is not configured
 * - the message is not a slash command
 * - the sender's matched group permits the command
 *
 * Returns { allowed: false, blockMessage } when the sender's group denies the command.
 *
 * When no group matches the sender, a built-in safe fallback applies:
 * /status, /new, /reset are always permitted; all other commands are denied.
 */
export function checkFeishuCommandControl(params: {
  feishuCfg: { commandControl?: unknown; userGroups?: unknown } | undefined;
  senderId: string;
  senderUserId?: string | null;
  commandBody: string;
}): CommandControlResult {
  const { feishuCfg, senderId, senderUserId, commandBody } = params;

  const commandControl = feishuCfg?.commandControl as CommandControlConfig | undefined;
  if (!commandControl?.groups?.length) {
    return { allowed: true };
  }

  const command = extractCommandToken(commandBody);
  if (!command) {
    return { allowed: true };
  }

  const userGroups = (feishuCfg?.userGroups ?? {}) as Record<string, Array<string | number>>;
  const senderIds = [senderId, senderUserId].filter((id): id is string => Boolean(id));

  for (const group of commandControl.groups) {
    const resolvedMembers = resolveMembers(userGroups, group.members, group.name);
    if (!senderMatchesMembers(resolvedMembers, senderIds)) {
      continue;
    }
    const allowed = isCommandAllowedInGroup(group, command);
    if (!allowed) {
      return { allowed: false, matchedGroup: group.name, blockMessage: commandControl.blockMessage };
    }
    return { allowed: true, matchedGroup: group.name };
  }

  // No group matched: apply built-in safe defaults.
  // These commands are always available even without explicit group configuration,
  // so that users don't lose basic functionality when commandControl is first deployed.
  const FALLBACK_COMMANDS = ["/status", "/new", "/reset"];
  return {
    allowed: FALLBACK_COMMANDS.includes(command),
    blockMessage: commandControl.blockMessage,
  };
}
