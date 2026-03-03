import { Type, type Static } from "@sinclair/typebox";

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

const DocType = Type.Union([
  Type.Literal("docx", { description: "New generation document (default)" }),
  Type.Literal("doc", { description: "Legacy document" }),
]);

const AsAccountId = Type.Optional(
  Type.String({
    description:
      "Operate as a specific Feishu account (requires allowedSupervisors config on target account).",
  }),
);

export const FeishuDriveSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    folder_token: Type.Optional(
      Type.String({ description: "Folder token (optional, omit for root directory)" }),
    ),
    asAccountId: AsAccountId,
  }),
  Type.Object({
    action: Type.Literal("info"),
    file_token: Type.String({ description: "File or folder token" }),
    type: FileType,
    asAccountId: AsAccountId,
  }),
  Type.Object({
    action: Type.Literal("create_folder"),
    name: Type.String({ description: "Folder name" }),
    folder_token: Type.Optional(
      Type.String({ description: "Parent folder token (optional, omit for root)" }),
    ),
    asAccountId: AsAccountId,
  }),
  Type.Object({
    action: Type.Literal("move"),
    file_token: Type.String({ description: "File token to move" }),
    type: FileType,
    folder_token: Type.String({ description: "Target folder token" }),
    asAccountId: AsAccountId,
  }),
  Type.Object({
    action: Type.Literal("delete"),
    file_token: Type.String({ description: "File token to delete" }),
    type: FileType,
    asAccountId: AsAccountId,
  }),
  Type.Object({
    action: Type.Literal("import_document"),
    title: Type.String({
      description: "Document title",
    }),
    content: Type.String({
      description: "Markdown content to import. Supports full Markdown syntax including tables, lists, code blocks, etc.",
    }),
    folder_token: Type.Optional(
      Type.String({
        description: "Target folder token (optional, defaults to root). Use 'list' to find folder tokens.",
      }),
    ),
    doc_type: Type.Optional(DocType),
    asAccountId: AsAccountId,
  }),
]);

export type FeishuDriveParams = Static<typeof FeishuDriveSchema>;
