import { Type, type Static } from "@sinclair/typebox";

const ADMIN_ACTION_VALUES = [
  "rebuild_index",
  "search_observed",
  "verify_matrix",
  "explain_visibility",
] as const;

export const FeishuIdAdminSchema = Type.Object({
  action: Type.Unsafe<(typeof ADMIN_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...ADMIN_ACTION_VALUES],
    description:
      "Action: rebuild_index | search_observed | verify_matrix | explain_visibility",
  }),
  query: Type.Optional(
    Type.String({
      description: "Single person/chat query used by search_observed or explain_visibility.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description: "One or more person queries for verify_matrix.",
    }),
  ),
  account_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional account IDs to verify against. Defaults to the effective calling account only.",
    }),
  ),
  refresh_index: Type.Optional(
    Type.Boolean({
      description: "Force rebuild of the local observed index before running the action.",
    }),
  ),
  exhaustive: Type.Optional(
    Type.Boolean({
      description:
        "For verify_matrix / explain_visibility, keep testing additional routes after the first success.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Result limit for search_observed (default: 20).",
    }),
  ),
  asAccountId: Type.Optional(
    Type.String({
      description:
        "Execute as a specific Feishu bot account (requires allowedSupervisors config on the target account).",
    }),
  ),
});

export type FeishuIdAdminParams = Static<typeof FeishuIdAdminSchema>;
