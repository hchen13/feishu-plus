// feishu_get_message_file tool
//
// Lets the agent fetch a Feishu message attachment (file or image) by message_id +
// file_key when those identifiers appear in the chat history. Solves the case where a
// user sends a file in one message (without @-mentioning the bot), then mentions the
// bot in a later message asking about that file. Without this tool, the agent only
// sees a raw file_key string and cannot read the actual content.
//
// Implementation notes:
// - PDF text extraction uses pdfjs-dist directly. The package is already present in
//   feishu-plus/node_modules as a transitive dep of openclaw, so no new declared dep.
// - Text-style files (txt/md/csv/json/html/utf-8 buffers) are decoded inline.
// - Image files are returned as image content blocks via openclaw's `imageResultFromFile`,
//   which the cross-provider tool-result serializer (Anthropic / OpenAI Completions /
//   OpenAI Responses) handles natively for vision-capable models.
// - Office binary formats (docx/xlsx/pptx/doc/xls/ppt) are not supported by openclaw
//   itself today; we return a clear error rather than silently dropping the content.
// - Wrapping format (`<file ...>` + `<<<...EXTERNAL_UNTRUSTED_CONTENT id=...>>>`) mirrors
//   what openclaw's native dispatch path produces, so the LLM sees identical structure
//   regardless of whether the file arrived via dispatch or via this tool.

import { Type, type Static } from "@sinclair/typebox";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { imageResultFromFile, jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { downloadMessageResourceFeishu } from "./media.js";
import { makeFeishuToolFactory, resolveToolAccount } from "./tools-common/tool-exec.js";

// =============================================================================
// Schema
// =============================================================================

export const FeishuGetMessageFileSchema = Type.Object({
  message_id: Type.String({
    description:
      "The Feishu message ID (om_...) of the message that originally carried the file/image attachment.",
  }),
  file_key: Type.String({
    description:
      "The file_key (e.g. file_v3_... or img_v3_...) identifying the attachment within that message.",
  }),
  resource_type: Type.Optional(
    Type.Union([Type.Literal("file"), Type.Literal("image")], {
      description:
        "Optional hint: 'file' for documents/PDFs/text files, 'image' for image files. Defaults to 'file' if omitted.",
    }),
  ),
  file_name: Type.Optional(
    Type.String({
      description:
        "Optional original filename hint (e.g. 'Statement_202601.pdf'). Used to disambiguate mime detection when the binary's magic bytes are ambiguous.",
    }),
  ),
});

type FeishuGetMessageFileParams = Static<typeof FeishuGetMessageFileSchema>;

// =============================================================================
// Limits
// =============================================================================

const MAX_PDF_PAGES = 50;
const MAX_INLINED_TEXT_CHARS = 200_000; // ~80KB of text, safe for context
const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30 MB hard cap (matches feishu mediaMaxMb default)

// =============================================================================
// MIME detection (magic bytes + filename extension)
// =============================================================================

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  log: "text/plain",
  conf: "text/plain",
  toml: "text/plain",
  ini: "text/plain",
  tsv: "text/tab-separated-values",
};

function detectMimeFromBuffer(buf: Buffer, fileName?: string): string {
  if (buf.length >= 4) {
    // PDF: %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return "application/pdf";
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "image/jpeg";
    }
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return "image/png";
    }
    // GIF: GIF8
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
      return "image/gif";
    }
    // WEBP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }
    // HEIC/HEIF: ftypheic / ftypheix / ftypmif1 etc.
    if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
      const brand = buf.toString("ascii", 8, 12);
      if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") {
        return "image/heic";
      }
    }
    // ZIP-based Office formats (docx/xlsx/pptx start with PK\x03\x04)
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
      if (fileName) {
        const ext = fileName.toLowerCase().split(".").pop() ?? "";
        if (ext === "docx") {
          return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        }
        if (ext === "xlsx") {
          return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        }
        if (ext === "pptx") {
          return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        }
      }
      return "application/zip";
    }
    // Old MS Office binary (doc/xls/ppt): D0 CF 11 E0 A1 B1 1A E1
    if (
      buf.length >= 8 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0 &&
      buf[4] === 0xa1 &&
      buf[5] === 0xb1 &&
      buf[6] === 0x1a &&
      buf[7] === 0xe1
    ) {
      if (fileName) {
        const ext = fileName.toLowerCase().split(".").pop() ?? "";
        if (ext === "doc") return "application/msword";
        if (ext === "xls") return "application/vnd.ms-excel";
        if (ext === "ppt") return "application/vnd.ms-powerpoint";
      }
      return "application/x-cfb";
    }
  }

  // Filename extension fallback for text formats
  if (fileName) {
    const ext = fileName.toLowerCase().split(".").pop() ?? "";
    if (ext && TEXT_EXTENSIONS[ext]) {
      return TEXT_EXTENSIONS[ext];
    }
  }

  // Heuristic: looks-like-text fallback
  if (looksLikeText(buf)) {
    return "text/plain";
  }

  return "application/octet-stream";
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(4096, buf.length));
  if (sample.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0) return false; // null byte → binary
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) {
      printable++;
    } else if (b >= 0x80) {
      // UTF-8 continuation / multibyte: count as printable
      printable++;
    }
  }
  return printable / sample.length > 0.85;
}

// =============================================================================
// Format-specific extractors
// =============================================================================

async function extractPdfText(buffer: Buffer, maxPages: number): Promise<string> {
  // Dynamic import: pdfjs-dist is present transitively via openclaw, no declared dep.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfjs has its own typings
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
  }).promise;
  const totalPages: number = pdf.numPages;
  const effectivePages = Math.min(totalPages, maxPages);
  const parts: string[] = [];
  for (let i = 1; i <= effectivePages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- content item shape
    const pageText = (content.items as any[])
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) parts.push(pageText);
  }
  let text = parts.join("\n\n");
  if (totalPages > maxPages) {
    text += `\n\n[Note: PDF has ${totalPages} pages, only first ${maxPages} extracted]`;
  }
  return text;
}

function decodeUtf8Text(buffer: Buffer): string {
  // Try strict UTF-8 first; fall back to latin-1 if invalid sequences appear
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("latin1");
  }
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n[Note: content truncated, ${text.length - maxChars} more characters omitted]`
  );
}

// =============================================================================
// Wrapping (mirrors openclaw's renderFileContextBlock + wrapExternalContent)
// =============================================================================

function escapeXmlAttr(value: string): string {
  return value.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

function escapeFileBlockContent(value: string): string {
  // Defang any inner </file> or <file ... so the wrapper can't be escaped early
  return value
    .replace(/<\s*\/\s*file\s*>/gi, "&lt;/file&gt;")
    .replace(/<\s*file\b/gi, "&lt;file");
}

function wrapAsFileBlock(filename: string, mimeType: string, content: string): string {
  const safeName = (filename.replace(/[\r\n\t]+/g, " ").trim() || "attachment");
  const safeContent = escapeFileBlockContent(content);
  const id = randomBytes(8).toString("hex");
  return [
    `<file name="${escapeXmlAttr(safeName)}" mime="${escapeXmlAttr(mimeType)}">`,
    `<<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
    safeContent,
    `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
    `</file>`,
  ].join("\n");
}

// =============================================================================
// Tool result helpers (text path)
// =============================================================================

function makeTextResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function makeErrorResult(errorMsg: string, details: Record<string, unknown> = {}) {
  return makeTextResult(`[feishu_get_message_file error] ${errorMsg}`, {
    status: "failed",
    error: errorMsg,
    ...details,
  });
}

// =============================================================================
// Image temp file save (for imageResultFromFile, which expects a file path)
// =============================================================================

async function writeBufferToTempFile(buffer: Buffer, suggestedName?: string): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-tool-"));
  const baseName = suggestedName?.replace(/[^A-Za-z0-9._-]/g, "_") || "image";
  const filePath = path.join(tmpDir, baseName);
  await fsp.writeFile(filePath, buffer);
  return filePath;
}

// =============================================================================
// Main execute
// =============================================================================

async function executeFeishuGetMessageFile(
  api: OpenClawPluginApi,
  agentAccountId: string | undefined,
  agentId: string | undefined,
  params: FeishuGetMessageFileParams,
) {
  if (!api.config) {
    return makeErrorResult("Feishu config is not available in this gateway runtime.");
  }

  const messageId = params.message_id?.trim();
  const fileKey = params.file_key?.trim();
  if (!messageId || !fileKey) {
    return makeErrorResult("Both 'message_id' and 'file_key' are required.");
  }

  // Resolve which Feishu account to use (same routing as other feishu_* tools)
  let account;
  try {
    account = resolveToolAccount(api.config, agentAccountId, agentId);
  } catch (err) {
    return makeErrorResult(
      `Could not resolve Feishu account context: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const downloadType: "file" | "image" = params.resource_type === "image" ? "image" : "file";

  // Step 1: download
  let buffer: Buffer;
  let downloadedFileName: string | undefined;
  try {
    const result = await downloadMessageResourceFeishu({
      cfg: api.config,
      messageId,
      fileKey,
      type: downloadType,
      accountId: account.accountId,
    });
    buffer = result.buffer;
    downloadedFileName = result.fileName;
  } catch (err) {
    return makeErrorResult(
      `Download failed (file_key may have expired, message_id may be wrong, or the bot may lack im:resource permission): ${err instanceof Error ? err.message : String(err)}`,
      { message_id: messageId, file_key: fileKey, account_id: account.accountId },
    );
  }

  if (!buffer || buffer.length === 0) {
    return makeErrorResult("Downloaded buffer is empty.", {
      message_id: messageId,
      file_key: fileKey,
    });
  }

  if (buffer.length > MAX_FILE_BYTES) {
    return makeErrorResult(
      `File too large: ${buffer.length} bytes (limit: ${MAX_FILE_BYTES} bytes)`,
      { message_id: messageId, file_key: fileKey, size: buffer.length },
    );
  }

  // Step 2: detect mime
  const fileName = params.file_name || downloadedFileName;
  const mime = detectMimeFromBuffer(buffer, fileName);

  // Step 3: branch by mime type
  try {
    if (mime === "application/pdf") {
      const text = await extractPdfText(buffer, MAX_PDF_PAGES);
      const trimmed = text.trim();
      if (!trimmed) {
        return makeErrorResult(
          "PDF parsed successfully but contained no extractable text (it may be a scanned image PDF).",
          { message_id: messageId, file_key: fileKey, mime, size: buffer.length },
        );
      }
      const wrapped = wrapAsFileBlock(
        fileName ?? "document.pdf",
        mime,
        clampText(trimmed, MAX_INLINED_TEXT_CHARS),
      );
      return makeTextResult(wrapped, {
        status: "ok",
        kind: "text",
        mime,
        filename: fileName ?? null,
        size: buffer.length,
        text_chars: trimmed.length,
      });
    }

    if (
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml"
    ) {
      const text = decodeUtf8Text(buffer);
      const wrapped = wrapAsFileBlock(
        fileName ?? "attachment.txt",
        mime,
        clampText(text, MAX_INLINED_TEXT_CHARS),
      );
      return makeTextResult(wrapped, {
        status: "ok",
        kind: "text",
        mime,
        filename: fileName ?? null,
        size: buffer.length,
        text_chars: text.length,
      });
    }

    if (mime.startsWith("image/")) {
      const tmpPath = await writeBufferToTempFile(buffer, fileName);
      // imageResultFromFile reads the bytes and constructs a tool result with
      // an image content block. The cross-provider serializer in pi-ai handles
      // the rest for Anthropic / OpenAI Completions / OpenAI Responses.
      const result = await imageResultFromFile({
        label: `Feishu image attachment${fileName ? ` (${fileName})` : ""}`,
        path: tmpPath,
        extraText: `Feishu image attachment${fileName ? ` "${fileName}"` : ""} (${mime}, ${buffer.length} bytes)`,
        details: {
          status: "ok",
          kind: "image",
          mime,
          filename: fileName ?? null,
          size: buffer.length,
          message_id: messageId,
          file_key: fileKey,
        },
      });
      return result;
    }

    // Unsupported binary formats: docx/xlsx/pptx/doc/xls/ppt/zip/octet-stream
    const officeHints: Record<string, string> = {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Microsoft Word .docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Microsoft Excel .xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "Microsoft PowerPoint .pptx",
      "application/msword": "Microsoft Word .doc (legacy)",
      "application/vnd.ms-excel": "Microsoft Excel .xls (legacy)",
      "application/vnd.ms-powerpoint": "Microsoft PowerPoint .ppt (legacy)",
      "application/zip": "ZIP archive",
    };
    const friendly = officeHints[mime];
    const hint = friendly
      ? `This file appears to be ${friendly}. OpenClaw does not currently have a built-in parser for this format. Please ask the user to convert it to PDF and re-send, or open it manually and paste the relevant content.`
      : `Unsupported binary mime type "${mime}". OpenClaw can natively read PDF, plain text, markdown, CSV, JSON, HTML, and image files. Please ask the user to convert this file to one of those formats.`;
    return makeErrorResult(hint, {
      message_id: messageId,
      file_key: fileKey,
      mime,
      filename: fileName ?? null,
      size: buffer.length,
    });
  } catch (err) {
    return makeErrorResult(
      `Failed to process file as ${mime}: ${err instanceof Error ? err.message : String(err)}`,
      {
        message_id: messageId,
        file_key: fileKey,
        mime,
        filename: fileName ?? null,
        size: buffer.length,
      },
    );
  }
}

// =============================================================================
// Registration
// =============================================================================

export function registerFeishuMessageFileTool(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_get_message_file: No config available, skipping registration");
    return;
  }

  api.registerTool(
    makeFeishuToolFactory((agentAccountId, agentId) => ({
      name: "feishu_get_message_file",
      label: "Feishu Get Message File",
      description:
        "Fetch the contents of a Feishu message attachment (file or image) by its message_id and file_key. " +
        "Use this when chat history shows a [feishu_attachment ...] reference and the user is asking about " +
        "the contents of that file. For PDFs/text/markdown/CSV/JSON/HTML and other text-based formats, " +
        "the extracted text is returned wrapped in a <file> block. For image files (jpg/png/webp/gif/heic), " +
        "the image is returned as a multimodal attachment for vision-capable models. Microsoft Office binary " +
        "formats (docx/xlsx/pptx) are not currently supported.",
      parameters: FeishuGetMessageFileSchema,
      async execute(_toolCallId: string, params: unknown) {
        return executeFeishuGetMessageFile(
          api,
          agentAccountId,
          agentId,
          params as FeishuGetMessageFileParams,
        );
      },
    })),
    { name: "feishu_get_message_file" },
  );

  api.logger.info?.("feishu_get_message_file: Registered feishu_get_message_file tool");
}
