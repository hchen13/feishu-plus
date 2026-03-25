import { Type, type Static } from "@sinclair/typebox";

const ID_ACTION_VALUES = [
  "resolve",
  "lookup",
  "whois",
  "members",
  "my_chats",
  "search_chats",
] as const;

const ID_TYPE_VALUES = ["open_id", "user_id", "union_id", "chat_id"] as const;

export const FeishuIdSchema = Type.Object({
  action: Type.Unsafe<(typeof ID_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...ID_ACTION_VALUES],
    description:
      "Action: resolve (ID conversion) | lookup (email/phone→ID) | whois (full profile) | members (chat members with all IDs) | my_chats (bot's chats) | search_chats (search by keyword)",
  }),

  // Used by: resolve, whois
  id: Type.Optional(
    Type.String({
      description:
        "Feishu ID to resolve. Prefix auto-detection: ou_=open_id, on_=union_id, oc_=chat_id. Required for resolve/whois.",
    }),
  ),

  // Used by: resolve, whois (when prefix is ambiguous)
  id_type: Type.Optional(
    Type.Unsafe<(typeof ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...ID_TYPE_VALUES],
      description:
        "Explicit ID type (required when ID has no recognizable prefix, e.g. user_id).",
    }),
  ),

  // Used by: lookup
  emails: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Personal email addresses to look up (max 50). Enterprise emails not supported.",
    }),
  ),
  mobiles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Phone numbers with country code (e.g. +8613800138000), max 50.",
    }),
  ),
  include_resigned: Type.Optional(
    Type.Boolean({
      description: "Include resigned users in lookup results (default: false).",
    }),
  ),

  // Used by: members
  chat_id: Type.Optional(
    Type.String({ description: "Chat ID (oc_xxx) for members action." }),
  ),

  // Used by: members, my_chats, search_chats
  page_size: Type.Optional(
    Type.Number({ description: "Page size (1-100)." }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from previous response." }),
  ),

  // Used by: search_chats
  query: Type.Optional(
    Type.String({
      description:
        "Search keyword for search_chats (max 64 chars, supports pinyin).",
    }),
  ),

  // Standard: asAccountId delegation
  asAccountId: Type.Optional(
    Type.String({
      description:
        "Execute as a specific Feishu bot account (for agents bound to multiple Feishu apps). " +
        "Use the account ID from the OpenClaw config (e.g. 'laok', 'laok-gradients').",
    }),
  ),
});

export type FeishuIdParams = Static<typeof FeishuIdSchema>;
