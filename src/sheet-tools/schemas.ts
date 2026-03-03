import { Type } from "@sinclair/typebox";
const AsAccountId = Type.Optional(
  Type.String({
    description:
      "Operate as a specific Feishu account (requires allowedSupervisors config on target account).",
  }),
);


export type FeishuSheetParams = {
  action:
    | "get_meta"
    | "read_range"
    | "write_range"
    | "append_rows"
    | "set_format"
    | "set_style"
    | "insert_image"
    | "insert_cell_image";
  spreadsheet_token?: string;
  url?: string;
  sheet_id?: string;
  range?: string;
  values?: unknown[][];
  value_render_option?: string;
  date_time_render_option?: string;
  value_input_option?: "RAW" | "USER_ENTERED";
  insert_data_option?: "OVERWRITE" | "INSERT_ROWS";
  format?: string;
  number_format?: string;
  style?: Record<string, unknown>;
  image_path?: string;
  imagePath?: string;
  cell?: string;
  width?: number;
  height?: number;
  offset_x?: number;
  offset_y?: number;
  float_image_token?: string;
  float_image_id?: string;
  image_name?: string;
};

export const FeishuSheetSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("get_meta"),
      Type.Literal("read_range"),
      Type.Literal("write_range"),
      Type.Literal("append_rows"),
      Type.Literal("set_format"),
      Type.Literal("set_style"),
      Type.Literal("insert_image"),
      Type.Literal("insert_cell_image"),
    ],
    { description: "Operation type" },
  ),
  spreadsheet_token: Type.Optional(
    Type.String({
      description: "Spreadsheet token (from URL /sheets/XXX). Optional if url is provided.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "Feishu Sheets URL. Supports /sheets/XXX, /sheet/XXX, and /wiki/XXX (wiki sheet node).",
    }),
  ),
  sheet_id: Type.Optional(
    Type.String({
      description:
        "Sheet ID (子表 ID, e.g. e7bea9). Used with A1 range like A1:C10, or with append_rows when range omitted.",
    }),
  ),
  range: Type.Optional(
    Type.String({
      description:
        "A1 notation range. Full form: sheetId!A1:C10. Short form A1:C10 also supported when sheet_id is provided.",
    }),
  ),
  values: Type.Optional(
    Type.Array(Type.Array(Type.Any()), {
      description: "2D array of cell values. Required by write_range and append_rows.",
    }),
  ),
  value_render_option: Type.Optional(
    Type.String({
      description:
        "Read value rendering. Use FORMATTED to get calculated display value, UNFORMATTED for raw text, FORMULA to keep formula source. `TOSTRING` kept for backward compatibility (mapped to UNFORMATTED).",
    }),
  ),
  date_time_render_option: Type.Optional(
    Type.String({
      description: "Read datetime rendering option, e.g. FormattedString or SerialNumber.",
    }),
  ),
  value_input_option: Type.Optional(
    Type.Union([Type.Literal("RAW"), Type.Literal("USER_ENTERED")], {
      description: "Write parsing option (default RAW). USER_ENTERED 会解析公式 =1+1。",
    }),
  ),
  insert_data_option: Type.Optional(
    Type.Union([Type.Literal("OVERWRITE"), Type.Literal("INSERT_ROWS")], {
      description: "append_rows behavior (default INSERT_ROWS).",
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Numeric format string for set_format, e.g. \"$#,##0.00\", \"0.00%\".",
    }),
  ),
  number_format: Type.Optional(
    Type.String({
      description: "Alias for format. Numeric format string for set_format, e.g. \"$#,##0.00\", \"0.00%\", \"0.00\".",
    }),
  ),
  style: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Cell style object for set_style. Supports keys: bold, italic, underline, fontSize, foreColor, backColor, or raw Feishu style fields.",
    }),
  ),
  image_path: Type.Optional(
    Type.String({
      description: "Local image path for insert_image action. Also accepted as imagePath.",
    }),
  ),
  imagePath: Type.Optional(
    Type.String({
      description: "Alias for image_path. Local image file path for insert_image action.",
    }),
  ),
  cell: Type.Optional(
    Type.String({
      description: "Cell address for insert_image (e.g. G1). Alias for range when used with insert_image.",
    }),
  ),
  width: Type.Optional(
    Type.Number({
      description: "Image width in px for insert_image action.",
    }),
  ),
  height: Type.Optional(
    Type.Number({
      description: "Image height in px for insert_image action.",
    }),
  ),
  offset_x: Type.Optional(
    Type.Number({
      description: "Image x-offset in px for insert_image action.",
    }),
  ),
  offset_y: Type.Optional(
    Type.Number({
      description: "Image y-offset in px for insert_image action.",
    }),
  ),
  float_image_token: Type.Optional(
    Type.String({
      description:
        "Image token for insert_image, if already uploaded to Feishu. If absent will auto-upload from image_path.",
    }),
  ),
  float_image_id: Type.Optional(
    Type.String({
      description: "Optional custom float_image_id for insert_image.",
    }),
  ),
  image_name: Type.Optional(
    Type.String({
      description:
        "Optional filename for insert_cell_image. Defaults to the basename of image_path.",
    }),
  ),

  asAccountId: AsAccountId,
});
