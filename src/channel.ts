import {
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/channel-policy";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/feishu";
import {
  resolveFeishuAccount,
  resolveFeishuCredentials,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
} from "./accounts.js";
import { addReactionFeishu, removeReactionFeishu } from "./reactions.js";
import {
  listFeishuDirectoryPeers,
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeersLive,
  listFeishuDirectoryGroupsLive,
} from "./directory.js";
import { feishuOnboardingAdapter } from "./onboarding.js";
import { feishuOutbound } from "./outbound.js";
import { resolveFeishuGroupToolPolicy } from "./policy.js";
import { probeFeishu } from "./probe.js";
import { sendMessageFeishu } from "./send.js";
import { normalizeFeishuTarget, looksLikeFeishuId, formatFeishuTarget } from "./targets.js";
import type { ResolvedFeishuAccount, FeishuConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu (飞书)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "飞书 enterprise messaging.",
  aliases: [],
  order: 70,
};

const secretInputJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "provider", "id"],
      properties: {
        source: { type: "string", enum: ["env", "file", "exec"] },
        provider: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

function setFeishuNamedAccountEnabled(
  cfg: ClawdbotConfig,
  accountId: string,
  enabled: boolean,
): ClawdbotConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: {
          ...feishuCfg?.accounts,
          [accountId]: {
            ...feishuCfg?.accounts?.[accountId],
            enabled,
          },
        },
      },
    },
  };
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "feishuUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|user|open_id):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageFeishu({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: true,
    media: true,
    reactions: true,
    edit: true,
    reply: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
      "- Feishu supports interactive cards for rich messages.",
    ],
  },
  groups: {
    resolveToolPolicy: resolveFeishuGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ['<at user_id="[^"]*">[^<]*</at>'],
  },
  reload: { configPrefixes: ["channels.feishu"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        defaultAccount: { type: "string" },
        appId: { type: "string" },
        appSecret: secretInputJsonSchema,
        encryptKey: secretInputJsonSchema,
        verificationToken: secretInputJsonSchema,
        domain: {
          oneOf: [
            { type: "string", enum: ["feishu"] },
            { type: "string", format: "uri", pattern: "^https://" },
          ],
        },
        connectionMode: { type: "string", enum: ["websocket", "webhook"] },
        webhookPath: { type: "string" },
        webhookHost: { type: "string" },
        webhookPort: { type: "integer", minimum: 1 },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        groupSenderAllowFrom: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        requireMention: { type: "boolean" },
        groupSessionScope: {
          type: "string",
          enum: ["group", "group_sender", "group_topic", "group_topic_sender"],
        },
        topicSessionMode: { type: "string", enum: ["disabled", "enabled"] },
        replyInThread: { type: "string", enum: ["disabled", "enabled"] },
        historyLimit: { type: "integer", minimum: 0 },
        dmHistoryLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
        chunkMode: { type: "string", enum: ["length", "newline"] },
        mediaMaxMb: { type: "number", minimum: 0 },
        renderMode: { type: "string", enum: ["auto", "raw", "card"] },
        streaming: { type: "boolean" },
        reactionNotifications: { type: "string", enum: ["off", "own", "all"] },
        typingIndicator: { type: "boolean" },
        resolveSenderNames: { type: "boolean" },
        tools: {
          type: "object",
          additionalProperties: false,
          properties: {
            doc: { type: "boolean" },
            chat: { type: "boolean" },
            wiki: { type: "boolean" },
            drive: { type: "boolean" },
            perm: { type: "boolean" },
            scopes: { type: "boolean" },
            task: { type: "boolean" },
            sheet: { type: "boolean" },
          },
        },
        milestoneContext: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            window: { type: "integer", minimum: 1 },
            maxChars: { type: "integer", minimum: 1 },
            keep: { type: "integer", minimum: 1 },
            llmInputTrace: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                outputDir: { type: "string" },
              },
            },
          },
        },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              appId: { type: "string" },
              appSecret: secretInputJsonSchema,
              encryptKey: secretInputJsonSchema,
              verificationToken: secretInputJsonSchema,
              domain: { type: "string", enum: ["feishu"] },
              connectionMode: { type: "string", enum: ["websocket", "webhook"] },
              webhookHost: { type: "string" },
              webhookPath: { type: "string" },
              webhookPort: { type: "integer", minimum: 1 },
              streaming: { type: "boolean" },
              tools: {
                type: "object",
                additionalProperties: false,
                properties: {
                  doc: { type: "boolean" },
                  chat: { type: "boolean" },
                  wiki: { type: "boolean" },
                  drive: { type: "boolean" },
                  perm: { type: "boolean" },
                  scopes: { type: "boolean" },
                  task: { type: "boolean" },
                  sheet: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // For default account, set top-level enabled
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: {
              ...cfg.channels?.feishu,
              enabled,
            },
          },
        };
      }

      // For named accounts, set enabled in accounts[accountId]
      return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // Delete entire feishu config
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).feishu;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      // Delete specific account from accounts
      const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
      const accounts = { ...feishuCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: {
            ...feishuCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      domain: account.domain,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      return mapAllowFromEntries(account.config?.allowFrom);
    },
    formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom }),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const feishuCfg = account.config;
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.feishu !== undefined,
        configuredGroupPolicy: feishuCfg?.groupPolicy,
        surface: `Feishu[${account.accountId}] groups`,
        openScope: "any member",
        groupPolicyPath: "channels.feishu.groupPolicy",
        groupAllowFromPath: "channels.feishu.groupAllowFrom",
      });
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: {
              ...cfg.channels?.feishu,
              enabled: true,
            },
          },
        };
      }

      return setFeishuNamedAccountEnabled(cfg, accountId, true);
    },
  },
  onboarding: feishuOnboardingAdapter,
  messaging: {
    normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeFeishuId,
      hint: "<chatId|user:openId|chat:chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryPeers({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listGroups: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryGroups({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listPeersLive: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryPeersLive({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listGroupsLive: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryGroupsLive({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
  },
  outbound: feishuOutbound,
  actions: {
    supportsAction: ({ action }) => {
      return action === "react";
    },
    handleAction: async (ctx) => {
      if (ctx.action === "react") {
        const messageId = (ctx.params.messageId ?? ctx.params.message_id) as string | undefined;
        const emoji = (ctx.params.emoji ?? ctx.params.emojiName) as string | undefined;
        const remove = ctx.params.remove as boolean | undefined;

        if (!messageId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "missing_message_id", hint: "messageId is required for Feishu reactions." }) }],
          };
        }
        if (!emoji && !remove) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "missing_emoji", hint: "emoji is required to add a Feishu reaction." }) }],
          };
        }

        try {
          const result = await addReactionFeishu({
            cfg: ctx.cfg,
            messageId,
            emojiType: (emoji ?? "THUMBSUP").toUpperCase(),
            accountId: ctx.accountId ?? undefined,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, reactionId: result.reactionId, emoji }) }],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: errMsg }) }],
          };
        }
      }

      return null as any;
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, {
        port: snapshot.port ?? null,
      }),
    probeAccount: async ({ account }) => await probeFeishu(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      domain: account.domain,
      ...buildRuntimeAccountStatusSnapshot({ runtime, probe }),
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorFeishuProvider } = await import("./monitor.js");
      const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const port = account.config?.webhookPort ?? null;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(
        `starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`,
      );
      return monitorFeishuProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
