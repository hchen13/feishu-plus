import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { FeishuIdSchema, type FeishuIdParams } from "./id-index-schema.js";
import {
  detectIdType,
  getEnrichedMembers,
  listMyChats,
  lookupByContact,
  resolveId,
  searchChats,
  whois,
  type FeishuResolvedIdType,
} from "./id-index-common.js";
import {
  hasFeishuToolEnabledForAnyAccount,
  makeFeishuToolFactory,
  withFeishuToolClient,
} from "./tools-common/tool-exec.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const TOOL_DESCRIPTION = `Feishu ID Index — query and convert Feishu IDs.

Actions:
- resolve: Convert any Feishu ID (open_id/union_id/user_id/chat_id) to all related IDs. Prefixes: ou_=open_id, on_=union_id, oc_=chat_id. Note: open_id is app-scoped (different bots see different open_ids for the same user).
- lookup: Find user IDs by email or phone. Only personal emails work (not enterprise email).
- whois: Get full user profile (name, department, job title, etc.) + all IDs from any user ID.
- members: List chat members with all ID types (open_id + union_id + user_id). Bot members are excluded (API limitation).
- my_chats: List all group chats the current bot has joined (excludes P2P direct messages).
- search_chats: Search chats by keyword (supports pinyin). Wrap keywords containing hyphens in quotes.`;

export function registerFeishuIdTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_id: No config available, skipping");
    return;
  }

  if (!hasFeishuToolEnabledForAnyAccount(api.config, "id")) {
    api.logger.debug?.("feishu_id: id tool disabled or no accounts configured");
    return;
  }

  api.registerTool(
    makeFeishuToolFactory((agentAccountId, agentId) => ({
      name: "feishu_id",
      label: "Feishu ID Index",
      description: TOOL_DESCRIPTION,
      parameters: FeishuIdSchema,
      async execute(_toolCallId, params) {
        const parsed = params as FeishuIdParams;
        const { asAccountId, ...rest } = parsed as FeishuIdParams & {
          asAccountId?: string;
        };

        return withFeishuToolClient({
          api,
          toolName: "feishu_id",
          requiredTool: "id",
          agentAccountId,
          agentId,
          asAccountId,
          run: async ({ client }) => {
            switch (rest.action) {
              case "resolve": {
                if (!rest.id) {
                  return json({ error: "resolve requires 'id' parameter" });
                }
                const idType = rest.id_type ?? detectIdType(rest.id);
                if (!idType) {
                  return json({
                    error: `Cannot detect ID type for "${rest.id}". Use id_type parameter. Known prefixes: ou_=open_id, on_=union_id, oc_=chat_id.`,
                  });
                }
                return json(await resolveId(client, rest.id, idType as FeishuResolvedIdType));
              }

              case "lookup": {
                if (!rest.emails?.length && !rest.mobiles?.length) {
                  return json({
                    error: "lookup requires at least one email or mobile number",
                  });
                }
                return json(
                  await lookupByContact(
                    client,
                    rest.emails,
                    rest.mobiles,
                    rest.include_resigned,
                  ),
                );
              }

              case "whois": {
                if (!rest.id) {
                  return json({ error: "whois requires 'id' parameter" });
                }
                const idType = rest.id_type ?? detectIdType(rest.id);
                if (!idType || idType === "chat_id") {
                  return json({
                    error:
                      idType === "chat_id"
                        ? "whois is for user IDs only. Use resolve for chat_id."
                        : `Cannot detect ID type for "${rest.id}". Use id_type parameter.`,
                  });
                }
                return json(
                  await whois(
                    client,
                    rest.id,
                    idType as Exclude<FeishuResolvedIdType, "chat_id">,
                  ),
                );
              }

              case "members": {
                const chatId =
                  rest.chat_id ?? (rest.id?.startsWith("oc_") ? rest.id : undefined);
                if (!chatId) {
                  return json({ error: "members requires chat_id (oc_xxx)" });
                }
                return json(
                  await getEnrichedMembers(
                    client,
                    chatId,
                    rest.page_size,
                    rest.page_token,
                  ),
                );
              }

              case "my_chats":
                return json(await listMyChats(client, rest.page_size, rest.page_token));

              case "search_chats": {
                if (!rest.query) {
                  return json({ error: "search_chats requires 'query' parameter" });
                }
                return json(
                  await searchChats(
                    client,
                    rest.query,
                    rest.page_size,
                    rest.page_token,
                  ),
                );
              }

              default:
                return json({ error: `Unknown action: ${String(rest.action)}` });
            }
          },
        });
      },
    })),
    { name: "feishu_id" },
  );

  api.logger.info?.("feishu_id: Registered feishu_id tool");
}
