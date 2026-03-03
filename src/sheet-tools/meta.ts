import type { SheetClient } from "./common.js";
import { runSheetApiCall } from "./common.js";

export type ParsedSheetUrl = {
  url_type: "sheets" | "sheet" | "wiki";
  token: string;
  sheet_id?: string;
  range?: string;
};

function parseHash(hash: string): { sheet_id?: string; range?: string } {
  const cleaned = hash.replace(/^#/, "").trim();
  if (!cleaned) return {};

  if (/^sht[a-zA-Z0-9]+$/.test(cleaned)) {
    return { sheet_id: cleaned };
  }

  const kv = new URLSearchParams(cleaned);
  const sheetId = kv.get("sheet") ?? kv.get("sheetId") ?? undefined;
  const range = kv.get("range") ?? undefined;
  return {
    ...(sheetId && { sheet_id: sheetId }),
    ...(range && { range }),
  };
}

export function parseSheetUrl(url: string): ParsedSheetUrl | null {
  try {
    const u = new URL(url);

    const hashInfo = parseHash(u.hash);
    const fromQuerySheetId = u.searchParams.get("sheet") ?? u.searchParams.get("sheetId") ?? undefined;
    const fromQueryRange = u.searchParams.get("range") ?? undefined;

    const sheet_id = hashInfo.sheet_id ?? fromQuerySheetId;
    const range = hashInfo.range ?? fromQueryRange;

    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) {
      return {
        url_type: "wiki",
        token: wikiMatch[1],
        ...(sheet_id && { sheet_id }),
        ...(range && { range }),
      };
    }

    const sheetsMatch = u.pathname.match(/\/sheets\/([A-Za-z0-9]+)/);
    if (sheetsMatch) {
      return {
        url_type: "sheets",
        token: sheetsMatch[1],
        ...(sheet_id && { sheet_id }),
        ...(range && { range }),
      };
    }

    const sheetMatch = u.pathname.match(/\/sheet\/([A-Za-z0-9]+)/);
    if (sheetMatch) {
      return {
        url_type: "sheet",
        token: sheetMatch[1],
        ...(sheet_id && { sheet_id }),
        ...(range && { range }),
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveSpreadsheetTokenFromWiki(client: SheetClient, wikiToken: string): Promise<string> {
  const res = await runSheetApiCall("wiki.space.getNode", () =>
    client.wiki.space.getNode({
      params: { token: wikiToken },
    }),
  );

  const node = res.data?.node;
  if (!node) throw new Error("Wiki node not found");
  if (node.obj_type !== "sheet") {
    throw new Error(`Wiki node is not a spreadsheet (type: ${node.obj_type})`);
  }

  if (!node.obj_token) {
    throw new Error("Wiki sheet node has no spreadsheet token");
  }

  return node.obj_token;
}

export async function resolveSpreadsheetInput(
  client: SheetClient,
  params: { spreadsheet_token?: string; url?: string; sheet_id?: string; range?: string },
): Promise<{
  spreadsheet_token: string;
  sheet_id?: string;
  range?: string;
  url_type?: string;
  source: "token" | "url";
}> {
  if (params.spreadsheet_token) {
    return {
      spreadsheet_token: params.spreadsheet_token,
      ...(params.sheet_id && { sheet_id: params.sheet_id }),
      ...(params.range && { range: params.range }),
      source: "token",
    };
  }

  if (!params.url) {
    throw new Error("Either spreadsheet_token or url is required");
  }

  const parsed = parseSheetUrl(params.url);
  if (!parsed) {
    throw new Error("Invalid Sheets URL. Expected /sheets/XXX, /sheet/XXX, or /wiki/XXX");
  }

  const spreadsheetToken =
    parsed.url_type === "wiki"
      ? await resolveSpreadsheetTokenFromWiki(client, parsed.token)
      : parsed.token;

  return {
    spreadsheet_token: spreadsheetToken,
    sheet_id: params.sheet_id ?? parsed.sheet_id,
    range: params.range ?? parsed.range,
    url_type: parsed.url_type,
    source: "url",
  };
}
