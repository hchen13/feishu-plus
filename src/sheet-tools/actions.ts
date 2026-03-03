import fs from "node:fs";
import path from "node:path";

import type { FeishuSheetParams } from "./schemas.js";
import type { SheetClient } from "./common.js";
import { runSheetApiCall } from "./common.js";
import { resolveSpreadsheetInput } from "./meta.js";

type SheetV2Response = {
  code?: number;
  msg?: string;
  data?: any;
};

type ColorInput = string | undefined;

function getRequester(client: SheetClient) {
  return (client as any).request?.bind(client) as
    | ((payload: {
        method: string;
        url: string;
        params?: Record<string, string>;
        data?: Record<string, unknown>;
      }) => Promise<SheetV2Response>)
    | undefined;
}

function shouldFallbackToLegacySheetPath(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b404\b/i.test(text) || /not found/i.test(text) || /unknown api/i.test(text);
}

async function callSheetApi(
  client: SheetClient,
  params: {
    spreadsheetToken: string;
    method: "get" | "put" | "post" | "patch";
    suffix: string;
    data?: Record<string, unknown>;
    query?: Record<string, string>;
    context: string;
    pathBase?: "/open-apis/sheets/v2" | "/open-apis/sheet/v2";
  },
): Promise<SheetV2Response> {
  const request = getRequester(client);
  if (!request) {
    throw new Error("Feishu client.request is unavailable");
  }

  const base = params.pathBase ?? "/open-apis/sheets/v2";
  const altBase = base === "/open-apis/sheets/v2" ? "/open-apis/sheet/v2" : "/open-apis/sheets/v2";

  const paths = [
    `${base}/spreadsheets/${params.spreadsheetToken}${params.suffix}`,
    `${altBase}/spreadsheets/${params.spreadsheetToken}${params.suffix}`,
  ];

  let lastErr: unknown;
  for (let i = 0; i < paths.length; i++) {
    const url = paths[i];
    try {
      const fn = async () =>
        await request({
          method: params.method.toUpperCase(),
          url,
          ...(params.query && { params: params.query }),
          ...(params.data && { data: params.data }),
        });

      return await runSheetApiCall(params.context, fn);
    } catch (err) {
      lastErr = err;
      const canTryFallback = i < paths.length - 1;
      if (canTryFallback && shouldFallbackToLegacySheetPath(err)) {
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function ensureValues(values: unknown): unknown[][] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty 2D array");
  }
  if (!values.every((row) => Array.isArray(row))) {
    throw new Error("values must be a 2D array (array of rows)");
  }
  return values as unknown[][];
}

/**
 * Convert formula strings to Feishu formula cell objects.
 * Feishu v2 API requires formulas to be written as {"type":"formula","text":"=1+1"},
 * not as plain strings. This transformation is needed regardless of valueInputOption.
 */
function transformValuesForFormulas(values: unknown[][]): unknown[][] {
  return values.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string" && cell.trim().startsWith("=")) {
        return { type: "formula", text: cell };
      }
      return cell;
    }),
  );
}

function normalizeRange(range: string, sheetId?: string): string {
  const trimmed = range.trim();
  if (!trimmed) throw new Error("range cannot be empty");
  if (trimmed.includes("!")) return trimmed;
  if (sheetId) return `${sheetId}!${trimmed}`;
  throw new Error(
    "range must include sheetId (e.g. shtxxx!A1:C10) or provide sheet_id separately",
  );
}

function resolveRangeForReadOrWrite(input: { range?: string; sheet_id?: string }): string {
  if (!input.range) {
    throw new Error("range is required for read_range/write_range");
  }
  return normalizeRange(input.range, input.sheet_id);
}

function resolveRangeForAppend(input: { range?: string; sheet_id?: string }): string {
  if (input.range) {
    return normalizeRange(input.range, input.sheet_id);
  }
  if (!input.sheet_id) {
    throw new Error("append_rows requires range or sheet_id");
  }
  // Append from first row anchor by default.
  return `${input.sheet_id}!A1:Z1`;
}

function resolveRangeForStyle(input: { range?: string; sheet_id?: string }): string {
  if (!input.range) {
    throw new Error("range is required for set_style/set_format" );
  }
  return normalizeRange(input.range, input.sheet_id);
}

function normalizeValueInputOption(value?: string): "RAW" | "USER_ENTERED" {
  if (!value) return "RAW";
  if (value.toUpperCase() === "USER_ENTERED") return "USER_ENTERED";
  return "RAW";
}

function normalizeValueRenderOption(value?: string): string {
  if (!value) return "UnformattedValue";

  const upper = value.trim().toUpperCase();

  if (upper === "TOVALUE" || upper === "TOSTRING" || upper === "UNFORMATTED") {
    return "UnformattedValue";
  }

  if (upper === "FORMATTED" || upper === "FORMATTEDVALUE") {
    return "FormattedValue";
  }

  if (upper === "UNFORMATTEDVALUE") {
    return "UnformattedValue";
  }

  if (upper === "FORMULA" || upper === "FORMULAS") {
    return "Formula";
  }

  return value;
}

function normalizeDateTimeRenderOption(value?: string): string {
  if (!value) return "FormattedString";
  return value.trim();
}

function normalizeCellStyle(styleInput: Record<string, unknown> | undefined) {
  const style = styleInput ?? {};
  const result: Record<string, unknown> = { ...style };
  const font: Record<string, unknown> = {};

  if (typeof style.bold === "boolean") {
    font.bold = style.bold;
    delete result.bold;
  }
  if (typeof style.italic === "boolean") {
    font.italic = style.italic;
    delete result.italic;
  }
  if (style.fontSize !== undefined) {
    if (typeof style.fontSize === "number") {
      font.fontSize = `${style.fontSize}pt/1.5`;
    } else if (typeof style.fontSize === "string") {
      font.fontSize = style.fontSize;
    }
    delete result.fontSize;
  }
  if (typeof style.underline === "boolean") {
    // textDecoration: 1/0 in public schema examples.
    result.textDecoration = style.underline ? 1 : 0;
    delete result.underline;
  }

  if (Object.keys(font).length > 0) {
    const baseFont =
      typeof style.font === "object" && style.font !== null ? (style.font as Record<string, unknown>) : {};
    result.font = {
      ...baseFont,
      ...font,
      clean: false,
    };
  }

  if (typeof style.foreColor === "string") {
    result.foreColor = normalizeColor(style.foreColor);
  }

  if (typeof style.backColor === "string") {
    result.backColor = normalizeColor(style.backColor);
  }

  return result;
}

function normalizeColor(raw: ColorInput): ColorInput {
  if (!raw) {
    return raw;
  }

  const text = String(raw).trim();
  if (!text.startsWith("#") && /^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(text)) {
    return `#${text}`;
  }
  return text;
}

function normalizeSingleCellRange(range: string): string {
  const trimmed = range.trim();
  // Already has a range part with colon (e.g. "sheetId!A1:A1" or "A1:A1")
  if (/[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(trimmed)) {
    return trimmed;
  }
  // Plain single cell without sheetId prefix (e.g. "G1")
  if (/^[A-Za-z]+\d+$/.test(trimmed)) {
    return `${trimmed}:${trimmed}`;
  }
  // sheetId!cellRef format (e.g. "68f4ac!G1") — expand to "68f4ac!G1:G1"
  const sheetCellMatch = trimmed.match(/^(.+)!([A-Za-z]+\d+)$/);
  if (sheetCellMatch) {
    return `${sheetCellMatch[1]}!${sheetCellMatch[2]}:${sheetCellMatch[2]}`;
  }
  return trimmed;
}

function resolveImageUploadFile(bufferPath: string) {
  const absPath = path.resolve(bufferPath);
  const fileName = path.basename(absPath);
  const buffer = fs.readFileSync(absPath);

  return { absPath, fileName, buffer };
}

function toFloatImageCreatePayload(p: FeishuSheetParams): Record<string, unknown> {
  return {
    float_image_token: p.float_image_token,
    range: p.range,
    width: p.width,
    height: p.height,
    offset_x: p.offset_x,
    offset_y: p.offset_y,
    float_image_id: p.float_image_id,
  };
}

export async function getSheetMeta(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);

  const [spreadsheetRes, sheetsRes] = await Promise.all([
    runSheetApiCall("sheets.spreadsheet.get", () =>
      client.sheets.spreadsheet.get({
        path: { spreadsheet_token: resolved.spreadsheet_token },
      }),
    ),
    runSheetApiCall("sheets.spreadsheetSheet.query", () =>
      client.sheets.spreadsheetSheet.query({
        path: { spreadsheet_token: resolved.spreadsheet_token },
      }),
    ),
  ]);

  const sheets = (sheetsRes.data?.sheets ?? []).map((sheet) => ({
    sheet_id: sheet.sheet_id,
    title: sheet.title,
    index: sheet.index,
    hidden: sheet.hidden,
    row_count: sheet.grid_properties?.row_count,
    column_count: sheet.grid_properties?.column_count,
    frozen_row_count: sheet.grid_properties?.frozen_row_count,
    frozen_column_count: sheet.grid_properties?.frozen_column_count,
  }));

  return {
    spreadsheet_token: resolved.spreadsheet_token,
    spreadsheet: {
      title: spreadsheetRes.data?.spreadsheet?.title,
      url: spreadsheetRes.data?.spreadsheet?.url,
      owner_id: spreadsheetRes.data?.spreadsheet?.owner_id,
      token: spreadsheetRes.data?.spreadsheet?.token,
    },
    sheets,
    ...(resolved.sheet_id && { sheet_id: resolved.sheet_id }),
    ...(resolved.range && { range: resolved.range }),
    ...(resolved.url_type && { url_type: resolved.url_type }),
    source: resolved.source,
    hint:
      sheets.length > 0
        ? `Use sheet_id from sheets list and range like "${sheets[0]?.sheet_id}!A1:C10"`
        : "No worksheet found in this spreadsheet",
  };
}

export async function readRange(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);
  const range = resolveRangeForReadOrWrite({ range: resolved.range, sheet_id: resolved.sheet_id });

  const query: Record<string, string> = {
    valueRenderOption: normalizeValueRenderOption(params.value_render_option),
  };

  if (params.date_time_render_option) {
    query.dateTimeRenderOption = normalizeDateTimeRenderOption(params.date_time_render_option);
  }

  const res = await callSheetApi(client, {
    spreadsheetToken: resolved.spreadsheet_token,
    method: "get",
    suffix: `/values/${encodeURIComponent(range)}`,
    query,
    context: "sheet.values.get",
  });

  const valueRange = res.data?.valueRange ?? {};
  return {
    spreadsheet_token: resolved.spreadsheet_token,
    range: valueRange.range ?? range,
    major_dimension: valueRange.majorDimension,
    values: valueRange.values ?? [],
    revision: res.data?.revision,
    source: resolved.source,
  };
}

export async function writeRange(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);
  const range = resolveRangeForReadOrWrite({ range: resolved.range, sheet_id: resolved.sheet_id });
  const rawValues = ensureValues(params.values);
  // Feishu v2 API requires formulas as {type:"formula",text:"=..."} objects.
  // Plain strings starting with "=" are NOT interpreted as formulas even with USER_ENTERED.
  const values = transformValuesForFormulas(rawValues);
  const valueInputOption = normalizeValueInputOption(params.value_input_option);

  const query: Record<string, string> = {
    valueInputOption,
  };

  const payload = {
    valueRange: {
      range,
      values,
    },
  };

  let res: SheetV2Response;
  try {
    res = await callSheetApi(client, {
      spreadsheetToken: resolved.spreadsheet_token,
      method: "put",
      suffix: "/values",
      query,
      data: payload,
      context: "sheet.values.put",
    });
  } catch {
    // Some environments expect PATCH for formula-enabled writes.
    res = await callSheetApi(client, {
      spreadsheetToken: resolved.spreadsheet_token,
      method: "patch",
      suffix: "/values",
      query,
      data: payload,
      context: "sheet.values.patch",
    });
  }

  const updates = res.data?.updates ?? {};
  return {
    success: true,
    spreadsheet_token: resolved.spreadsheet_token,
    range,
    revision: res.data?.revision,
    updated_range: updates.updatedRange ?? res.data?.updatedRange,
    updated_rows: updates.updatedRows ?? res.data?.updatedRows,
    updated_columns: updates.updatedColumns ?? res.data?.updatedColumns,
    updated_cells: updates.updatedCells ?? res.data?.updatedCells,
    source: resolved.source,
  };
}

export async function appendRows(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);
  const range = resolveRangeForAppend({ range: resolved.range, sheet_id: resolved.sheet_id });
  const rawValues = ensureValues(params.values);
  const values = transformValuesForFormulas(rawValues);
  const valueInputOption = normalizeValueInputOption(params.value_input_option);

  const query: Record<string, string> = {
    insertDataOption: params.insert_data_option ?? "INSERT_ROWS",
    valueInputOption,
  };

  const res = await callSheetApi(client, {
    spreadsheetToken: resolved.spreadsheet_token,
    method: "post",
    suffix: "/values_append",
    query,
    data: {
      valueInputOption,
      valueRange: {
        range,
        values,
      },
    },
    context: "sheet.values_append.post",
  });

  const updates = res.data?.updates ?? {};
  return {
    success: true,
    spreadsheet_token: resolved.spreadsheet_token,
    range,
    revision: res.data?.revision,
    table_range: res.data?.tableRange,
    updated_range: updates.updatedRange ?? res.data?.updatedRange,
    updated_rows: updates.updatedRows ?? res.data?.updatedRows,
    updated_columns: updates.updatedColumns ?? res.data?.updatedColumns,
    updated_cells: updates.updatedCells ?? res.data?.updatedCells,
    insert_data_option: query.insertDataOption,
    source: resolved.source,
  };
}

export async function setFormat(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);
  const range = resolveRangeForStyle({ range: resolved.range, sheet_id: resolved.sheet_id });

  const formatStr = params.number_format ?? params.format;
  if (!formatStr) {
    throw new Error("format (or number_format) is required for set_format");
  }

  // Feishu v2 style endpoint: PUT /open-apis/sheets/v2/spreadsheets/{token}/style
  // Body: { appendStyle: { range, style: { formatter } } }
  const res = await callSheetApi(client, {
    spreadsheetToken: resolved.spreadsheet_token,
    method: "put",
    pathBase: "/open-apis/sheets/v2",
    suffix: "/style",
    context: "sheets.style.put",
    data: {
      appendStyle: {
        range,
        style: {
          formatter: formatStr,
        },
      },
    },
  });

  return {
    success: true,
    spreadsheet_token: resolved.spreadsheet_token,
    range,
    updated: res.data ?? {},
    source: resolved.source,
  };
}

export async function setStyle(client: SheetClient, params: FeishuSheetParams) {
  const resolved = await resolveSpreadsheetInput(client, params);
  const range = resolveRangeForStyle({ range: resolved.range, sheet_id: resolved.sheet_id });

  const styleInput = params.style;
  if (!styleInput || typeof styleInput !== "object") {
    throw new Error("style is required and must be an object");
  }

  const style = normalizeCellStyle(styleInput as Record<string, unknown>);

  // Feishu v2 style endpoint: PUT /open-apis/sheets/v2/spreadsheets/{token}/style
  // Body: { appendStyle: { range, style: {...} } }
  const res = await callSheetApi(client, {
    spreadsheetToken: resolved.spreadsheet_token,
    method: "put",
    pathBase: "/open-apis/sheets/v2",
    suffix: "/style",
    context: "sheets.style.put",
    data: {
      appendStyle: {
        range,
        style,
      },
    },
  });

  return {
    success: true,
    spreadsheet_token: resolved.spreadsheet_token,
    range,
    updated: res.data ?? {},
    source: resolved.source,
  };
}

export async function insertCellImage(client: SheetClient, params: FeishuSheetParams) {
  const imagePath = params.image_path ?? params.imagePath;
  if (!imagePath) {
    throw new Error("image_path is required for insert_cell_image");
  }

  const cellRef = params.cell ?? params.range;
  if (!cellRef) {
    throw new Error("cell (or range) is required for insert_cell_image");
  }

  const spreadsheetToken = params.spreadsheet_token;
  if (!spreadsheetToken) {
    throw new Error("spreadsheet_token is required for insert_cell_image");
  }

  const sheetId = params.sheet_id;
  if (!sheetId) {
    throw new Error("sheet_id is required for insert_cell_image");
  }

  const absPath = path.resolve(imagePath);
  const fileName = params.image_name ?? path.basename(absPath);
  const buffer = fs.readFileSync(absPath);
  const base64 = buffer.toString("base64");

  // Build a single-cell range like "sheetId!L1:L1"
  const cellOnly = cellRef.includes("!") ? cellRef.split("!").pop()! : cellRef;
  const singleCell = cellOnly.includes(":") ? cellOnly.split(":")[0] : cellOnly;
  const range = `${sheetId}!${singleCell}:${singleCell}`;

  const request = getRequester(client);
  if (!request) {
    throw new Error("Feishu client.request is unavailable");
  }

  const res = await runSheetApiCall("sheet.values_image.post", () =>
    request({
      method: "POST",
      url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_image`,
      data: {
        range,
        image: base64,
        name: fileName,
      },
    }),
  );

  return {
    success: true,
    spreadsheet_token: spreadsheetToken,
    sheet_id: sheetId,
    range,
    name: fileName,
    code: res.code,
    msg: res.msg,
    data: res.data,
  };
}

export async function insertImage(client: SheetClient, params: FeishuSheetParams) {
  console.log("[DEBUG] insertImage called, params keys:", Object.keys(params));
  // Support imagePath as alias for image_path
  const imagePath = params.image_path ?? params.imagePath;
  if (!params.float_image_token && !imagePath) {
    throw new Error("image_path (or imagePath) is required when float_image_token is not provided");
  }

  // Support cell as alias for range in insert_image context
  const cellRange = params.range ?? params.cell;
  const resolvedParams = { ...params, image_path: imagePath, range: cellRange };

  const resolved = await resolveSpreadsheetInput(client, resolvedParams);
  if (!resolved.sheet_id) {
    throw new Error("sheet_id is required for insert_image (or include it in range / resolved context)");
  }

  if (!cellRange) {
    throw new Error("range or cell is required for insert_image (single cell like A1 or A1:A1)");
  }

  const floatImageToken = params.float_image_token
    ? Promise.resolve(params.float_image_token)
    : (async () => {
        const { fileName, buffer } = resolveImageUploadFile(imagePath!);
        const uploadRes = await runSheetApiCall("drive.media.uploadAll", () =>
          client.drive.media.uploadAll({
            data: {
              file_name: fileName,
              parent_type: "sheet_image",
              parent_node: resolved.spreadsheet_token,
              size: buffer.length,
              file: buffer,
            },
          }),
        );

        console.log("[DEBUG insert_image] uploadRes:", JSON.stringify(uploadRes));
        if (!uploadRes.file_token) {
          throw new Error("upload image failed: no file_token returned");
        }

        return uploadRes.file_token;
      })();

  const singleCellRange = normalizeSingleCellRange(normalizeRange(cellRange!, resolved.sheet_id));

  const payload = toFloatImageCreatePayload({
    ...params,
    range: singleCellRange,
    float_image_token: await floatImageToken,
  });

  console.log("[DEBUG insert_image] payload:", JSON.stringify(payload));
  console.log("[DEBUG insert_image] path:", JSON.stringify({ spreadsheet_token: resolved.spreadsheet_token, sheet_id: resolved.sheet_id }));

  let createRes: Awaited<ReturnType<typeof client.sheets.spreadsheetSheetFloatImage.create>>;
  try {
    createRes = await runSheetApiCall("sheets.spreadsheetSheetFloatImage.create", () =>
      client.sheets.spreadsheetSheetFloatImage.create({
        path: {
          spreadsheet_token: resolved.spreadsheet_token,
          sheet_id: resolved.sheet_id,
        },
        data: {
          ...payload,
        },
      }),
    );
  } catch (err) {
    // Log the raw error for debugging (including axios response body)
    const rawErr = err as Record<string, unknown> | undefined;
    const responseData = (rawErr?.response as { data?: unknown } | undefined)?.data;
    console.error("[DEBUG insert_image] float_image create error:", err instanceof Error ? err.message : String(err));
    if (responseData !== undefined) {
      console.error("[DEBUG insert_image] response.data:", JSON.stringify(responseData));
    }
    throw err;
  }

  return {
    success: true,
    spreadsheet_token: resolved.spreadsheet_token,
    sheet_id: resolved.sheet_id,
    inserted: createRes.data,
    source: resolved.source,
  };
}
