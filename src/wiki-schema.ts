import { Type, type Static, type TObject, type TProperties, type TUnion } from "@sinclair/typebox";

const AccountIdField = Type.Optional(
  Type.String({
    description:
      "Feishu bot account ID to use (for agents bound to multiple Feishu apps across organizations). " +
      "Matches the account key in OpenClaw config channels.feishu.accounts. " +
      "Omit to use the default account from the current context.",
  }),
);

const FeishuWikiActions = Type.Union([
  Type.Object({
    action: Type.Literal("spaces"),
  }),
  Type.Object({
    action: Type.Literal("nodes"),
    space_id: Type.String({ description: "Knowledge space ID" }),
    parent_node_token: Type.Optional(
      Type.String({ description: "Parent node token (optional, omit for root)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("get"),
    token: Type.String({ description: "Wiki node token (from URL /wiki/XXX)" }),
  }),
  Type.Object({
    action: Type.Literal("search"),
    query: Type.String({ description: "Search query" }),
    space_id: Type.Optional(Type.String({ description: "Limit search to this space (optional)" })),
  }),
  Type.Object({
    action: Type.Literal("create"),
    space_id: Type.String({ description: "Knowledge space ID" }),
    title: Type.String({ description: "Node title" }),
    obj_type: Type.Optional(
      Type.Union([Type.Literal("docx"), Type.Literal("sheet"), Type.Literal("bitable")], {
        description: "Object type (default: docx)",
      }),
    ),
    parent_node_token: Type.Optional(
      Type.String({ description: "Parent node token (optional, omit for root)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("move"),
    space_id: Type.String({ description: "Source knowledge space ID" }),
    node_token: Type.String({ description: "Node token to move" }),
    target_space_id: Type.Optional(
      Type.String({ description: "Target space ID (optional, same space if omitted)" }),
    ),
    target_parent_token: Type.Optional(
      Type.String({ description: "Target parent node token (optional, root if omitted)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("rename"),
    space_id: Type.String({ description: "Knowledge space ID" }),
    node_token: Type.String({ description: "Node token to rename" }),
    title: Type.String({ description: "New title" }),
  }),
]);

// See doc-schema.ts for the rationale: we emit anyOf of flat objects instead
// of Type.Intersect to avoid OpenAI rejecting top-level allOf, and the cast
// preserves per-variant discriminated-union narrowing in wiki.ts.
type InjectAccountId<V> = V extends TObject<infer P>
  ? TObject<P & { accountId: typeof AccountIdField }>
  : never;
type WithAccountIdVariants<T extends readonly TObject<TProperties>[]> = {
  [K in keyof T]: InjectAccountId<T[K]>;
};

export const FeishuWikiSchema = Type.Union(
  FeishuWikiActions.anyOf.map((variant) =>
    Type.Object({ ...variant.properties, accountId: AccountIdField }),
  ),
) as unknown as TUnion<WithAccountIdVariants<typeof FeishuWikiActions.anyOf>>;

export type FeishuWikiParams = Static<typeof FeishuWikiSchema>;
