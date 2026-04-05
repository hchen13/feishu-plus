import { Type, type Static, type TObject, type TProperties, type TUnion } from "@sinclair/typebox";

const AccountIdField = Type.Optional(
  Type.String({
    description:
      "Feishu bot account ID to use (for agents bound to multiple Feishu apps across organizations). " +
      "Matches the account key in OpenClaw config channels.feishu.accounts. " +
      "Omit to use the default account from the current context.",
  }),
);

const TokenType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("wiki"),
  Type.Literal("mindnote"),
]);

const MemberType = Type.Union([
  Type.Literal("email"),
  Type.Literal("openid"),
  Type.Literal("userid"),
  Type.Literal("unionid"),
  Type.Literal("openchat"),
  Type.Literal("opendepartmentid"),
]);

const Permission = Type.Union([
  Type.Literal("view"),
  Type.Literal("edit"),
  Type.Literal("full_access"),
]);

const FeishuPermActions = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    token: Type.String({ description: "File token" }),
    type: TokenType,
  }),
  Type.Object({
    action: Type.Literal("add"),
    token: Type.String({ description: "File token" }),
    type: TokenType,
    member_type: MemberType,
    member_id: Type.String({ description: "Member ID (email, open_id, user_id, etc.)" }),
    perm: Permission,
  }),
  Type.Object({
    action: Type.Literal("remove"),
    token: Type.String({ description: "File token" }),
    type: TokenType,
    member_type: MemberType,
    member_id: Type.String({ description: "Member ID to remove" }),
  }),
]);

// See doc-schema.ts for the rationale: we emit anyOf of flat objects instead
// of Type.Intersect to avoid OpenAI rejecting top-level allOf, and the cast
// preserves per-variant discriminated-union narrowing in perm.ts.
type InjectAccountId<V> = V extends TObject<infer P>
  ? TObject<P & { accountId: typeof AccountIdField }>
  : never;
type WithAccountIdVariants<T extends readonly TObject<TProperties>[]> = {
  [K in keyof T]: InjectAccountId<T[K]>;
};

export const FeishuPermSchema = Type.Union(
  FeishuPermActions.anyOf.map((variant) =>
    Type.Object({ ...variant.properties, accountId: AccountIdField }),
  ),
) as unknown as TUnion<WithAccountIdVariants<typeof FeishuPermActions.anyOf>>;

export type FeishuPermParams = Static<typeof FeishuPermSchema>;
