import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { hasFeishuToolEnabledForAnyAccount, withFeishuToolClient, makeFeishuToolFactory } from "../tools-common/tool-exec.js";
import {
  appendRows,
  getSheetMeta,
  insertCellImage,
  insertImage,
  readRange,
  setFormat,
  setStyle,
  writeRange,
} from "./actions.js";
import { errorResult, json, type SheetClient } from "./common.js";
import { FeishuSheetSchema, type FeishuSheetParams } from "./schemas.js";

export function registerFeishuSheetTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_sheet: No config available, skipping sheet tool");
    return;
  }

  if (!hasFeishuToolEnabledForAnyAccount(api.config)) {
    api.logger.debug?.("feishu_sheet: No Feishu accounts configured, skipping sheet tool");
    return;
  }

  if (!hasFeishuToolEnabledForAnyAccount(api.config, "sheet")) {
    api.logger.debug?.("feishu_sheet: sheet tool disabled in config");
    return;
  }

  api.registerTool(
    makeFeishuToolFactory((agentAccountId, agentId) => ({
      name: "feishu_sheet",
      label: "Feishu Sheet",
      description:
        "Feishu spreadsheet operations. Actions: get_meta, read_range, write_range, append_rows, set_format, set_style, insert_image, insert_cell_image. Supports token or sheet URL.",
      parameters: FeishuSheetSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuSheetParams;
        const asAccountId = (params as any).asAccountId as string | undefined;

        try {
          return await withFeishuToolClient({
            api,
            toolName: "feishu_sheet",
            requiredTool: "sheet",
            agentAccountId,
            agentId,
            asAccountId,
            run: async ({ client }) => {
              const sheetClient = client as SheetClient;

              switch (p.action) {
                case "get_meta":
                  return json(await getSheetMeta(sheetClient, p));
                case "read_range":
                  return json(await readRange(sheetClient, p));
                case "write_range":
                  return json(await writeRange(sheetClient, p));
                case "append_rows":
                  return json(await appendRows(sheetClient, p));
                case "set_format":
                  return json(await setFormat(sheetClient, p));
                case "set_style":
                  return json(await setStyle(sheetClient, p));
                case "insert_image":
                  return json(await insertImage(sheetClient, p));
                case "insert_cell_image":
                  return json(await insertCellImage(sheetClient, p));
                default:
                  return json({ error: `Unknown action: ${(p as any).action}` });
              }
            },
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    })),
    { name: "feishu_sheet" },
  );

  api.logger.debug?.("feishu_sheet: Registered feishu_sheet tool");
}
