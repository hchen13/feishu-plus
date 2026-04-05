import { Type, type Static, type TObject, type TProperties, type TUnion } from "@sinclair/typebox";

const AccountIdField = Type.Optional(
  Type.String({
    description:
      "Feishu bot account ID to use (for agents bound to multiple Feishu apps across organizations). " +
      "Matches the account key in OpenClaw config channels.feishu.accounts. " +
      "Omit to use the default account from the current context.",
  }),
);

const FileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("mindnote"),
  Type.Literal("shortcut"),
]);

const FeishuDriveActions = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    folder_token: Type.Optional(
      Type.String({ description: "Folder token (optional, omit for root directory)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("info"),
    file_token: Type.String({ description: "File or folder token" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("create_folder"),
    name: Type.String({ description: "Folder name" }),
    folder_token: Type.Optional(
      Type.String({ description: "Parent folder token (optional, omit for root)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("move"),
    file_token: Type.String({ description: "File token to move" }),
    type: FileType,
    folder_token: Type.String({ description: "Target folder token" }),
  }),
  Type.Object({
    action: Type.Literal("delete"),
    file_token: Type.String({ description: "File token to delete" }),
    type: FileType,
  }),
]);

// See doc-schema.ts for the rationale: we emit anyOf of flat objects instead
// of Type.Intersect to avoid OpenAI rejecting top-level allOf, and the cast
// preserves per-variant discriminated-union narrowing in drive.ts.
type InjectAccountId<V> = V extends TObject<infer P>
  ? TObject<P & { accountId: typeof AccountIdField }>
  : never;
type WithAccountIdVariants<T extends readonly TObject<TProperties>[]> = {
  [K in keyof T]: InjectAccountId<T[K]>;
};

export const FeishuDriveSchema = Type.Union(
  FeishuDriveActions.anyOf.map((variant) =>
    Type.Object({ ...variant.properties, accountId: AccountIdField }),
  ),
) as unknown as TUnion<WithAccountIdVariants<typeof FeishuDriveActions.anyOf>>;

export type FeishuDriveParams = Static<typeof FeishuDriveSchema>;
