// feishu_get_message_file tool
//
// Downloads a Feishu message attachment (file/image/audio/video) to a path
// on disk that the agent chooses, then returns the absolute path so the
// agent can read it with its own file tools (Read, read_file, etc.).
//
// This plugin does NOT parse, extract, or interpret file contents. PDF
// extraction, image vision, text decoding, etc. are all the agent's job.
// Keeping the plugin format-agnostic means new file types just work as
// soon as the agent's own tools learn to read them.
//
// Workflow:
//   1. User drops a file into a group chat without @-mentioning the bot.
//      bot.ts records the attachment as `[feishu_attachment type=file
//      message_id=… key=… name="…"]` in GroupSense pending history. No
//      network calls happen at this point.
//   2. User follows up with `@bot 帮我看看这个 pdf`. The agent sees the
//      attachment marker in its context.
//   3. Agent decides to read the file → calls feishu_get_message_file with
//      the message_id, file_key, and a target path.
//   4. Plugin downloads via Feishu's im.messageResource.get and writes the
//      bytes to disk.
//   5. Agent uses its own Read/read_file tool on the returned path.

import { Type, type Static } from "@sinclair/typebox";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { downloadMessageResourceFeishu } from "./media.js";
import { makeFeishuToolFactory, withFeishuToolClient } from "./tools-common/tool-exec.js";

// =============================================================================
// Schema
// =============================================================================

export const FeishuGetMessageFileSchema = Type.Object({
  message_id: Type.String({
    description:
      "The Feishu message ID (om_...) of the message that originally carried the attachment. " +
      "Read this from the `message_id=...` field of a [feishu_attachment ...] marker in your context.",
  }),
  file_key: Type.String({
    description:
      "The file_key (file_v3_... or img_v3_...) identifying the attachment within that message. " +
      "Read this from the `key=...` field of a [feishu_attachment ...] marker.",
  }),
  save_to: Type.String({
    description:
      "Absolute filesystem path where the file should be written. " +
      "If `save_to` looks like a directory (ends with a separator, points at an existing directory, " +
      "or has no file extension), the filename from `original_filename` (or 'attachment' as a fallback) " +
      "is appended inside it. Otherwise `save_to` is treated as the full target file path. " +
      "Parent directories are created if they do not exist.",
  }),
  original_filename: Type.Optional(
    Type.String({
      description:
        "Optional original filename, sourced from the `name=\"…\"` field of the [feishu_attachment ...] " +
        "marker. Used as the basename when `save_to` resolves to a directory. Ignored when `save_to` " +
        "is a full file path.",
    }),
  ),
  resource_type: Type.Optional(
    Type.Union([Type.Literal("file"), Type.Literal("image")], {
      description:
        "Hint to Feishu's messageResource API. Use 'image' when the [feishu_attachment ...] marker " +
        "shows `type=image`, otherwise 'file' (covers documents, audio, video, generic files). " +
        "Defaults to 'file'.",
    }),
  ),
  asAccountId: Type.Optional(
    Type.String({
      description:
        "Optional Feishu accountId override for agents bound to multiple Feishu apps. " +
        "Omit when the agent has a single binding.",
    }),
  ),
});

type FeishuGetMessageFileParams = Static<typeof FeishuGetMessageFileSchema>;

// =============================================================================
// Limits
// =============================================================================

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB hard cap

// =============================================================================
// Result helpers
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
// Filename / path helpers
// =============================================================================

function sanitizeBaseName(name: string): string {
  // Strip path separators and characters that are unsafe across platforms.
  // Preserve dots, hyphens, underscores, and unicode characters (e.g. 中文).
  const cleaned = name
    .replace(/[\/\\]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .trim();
  return cleaned || "attachment";
}

async function isExistingDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide whether `saveTo` should be treated as a directory (filename appended)
 * or as a full file path (used as-is).
 *
 * Directory if any of:
 *   - ends with `/` or platform separator
 *   - already exists on disk as a directory
 *   - has no file extension AND its basename contains no `.`
 *     (so `/Users/x/feishu-downloads` is a directory, but `/Users/x/foo.pdf` is a file)
 */
async function resolveSaveMode(saveTo: string): Promise<"directory" | "file"> {
  if (saveTo.endsWith(path.sep) || saveTo.endsWith("/")) return "directory";
  if (await isExistingDirectory(saveTo)) return "directory";
  const basename = path.basename(saveTo);
  if (path.extname(basename) === "" && !basename.includes(".")) {
    return "directory";
  }
  return "file";
}

// =============================================================================
// Main execute (runs inside withFeishuToolClient → account is resolved + checked)
// =============================================================================

async function downloadAndSave(
  api: OpenClawPluginApi,
  account: { accountId: string },
  params: FeishuGetMessageFileParams,
) {
  const messageId = params.message_id?.trim();
  const fileKey = params.file_key?.trim();
  const saveTo = params.save_to?.trim();
  if (!messageId || !fileKey || !saveTo) {
    return makeErrorResult(
      "Required fields missing: 'message_id', 'file_key', and 'save_to' must all be provided.",
    );
  }

  if (!path.isAbsolute(saveTo)) {
    return makeErrorResult(
      `'save_to' must be an absolute path. Got: ${saveTo}`,
      { save_to: saveTo },
    );
  }

  const downloadType: "file" | "image" = params.resource_type === "image" ? "image" : "file";

  // Step 1: download from Feishu (let underlying error message bubble through)
  let buffer: Buffer;
  try {
    const result = await downloadMessageResourceFeishu({
      cfg: api.config!,
      messageId,
      fileKey,
      type: downloadType,
      accountId: account.accountId,
    });
    buffer = result.buffer;
  } catch (err) {
    return makeErrorResult(
      err instanceof Error ? err.message : String(err),
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
      `File too large: ${buffer.length} bytes (limit ${MAX_FILE_BYTES} bytes / ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
      { message_id: messageId, file_key: fileKey, size: buffer.length },
    );
  }

  // Step 2: resolve target path
  let targetPath: string;
  let saveMode: "directory" | "file";
  try {
    saveMode = await resolveSaveMode(saveTo);
    if (saveMode === "directory") {
      const baseName = sanitizeBaseName(params.original_filename ?? "attachment");
      targetPath = path.resolve(saveTo, baseName);
    } else {
      targetPath = path.resolve(saveTo);
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  } catch (err) {
    return makeErrorResult(
      `Failed to prepare save path "${saveTo}": ${err instanceof Error ? err.message : String(err)}`,
      { save_to: saveTo },
    );
  }

  // Step 3: write to disk
  try {
    await fsp.writeFile(targetPath, buffer);
  } catch (err) {
    return makeErrorResult(
      `Failed to write file to ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      { save_to: saveTo, target_path: targetPath },
    );
  }

  // Step 4: build summary for the agent
  const sizeKb = (buffer.length / 1024).toFixed(1);
  const summaryLines = [
    `Saved Feishu attachment to: ${targetPath}`,
    `Save mode: ${saveMode === "directory" ? `directory (basename appended from original_filename or fallback)` : "file (save_to used as-is)"}`,
    `Size: ${buffer.length} bytes (${sizeKb} KB)`,
    "",
    "Use your own file-reading tool (Read, read_file, etc.) to inspect the contents.",
  ];

  return makeTextResult(summaryLines.join("\n"), {
    status: "ok",
    target_path: targetPath,
    save_mode: saveMode,
    size: buffer.length,
    original_filename: params.original_filename ?? null,
    message_id: messageId,
    file_key: fileKey,
    account_id: account.accountId,
  });
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
        "Download a Feishu message attachment (file / image / audio / video) to a local path. " +
        "This tool only saves the bytes — it does NOT parse PDFs, extract text, run OCR, or interpret " +
        "the file in any way. After this tool returns, use your own file-reading tool (Read, read_file, " +
        "etc.) on the returned path to inspect the contents.\n\n" +
        "When to use: you see a [feishu_attachment type=… message_id=… key=… name=\"…\"] marker in " +
        "group chat context and the user is asking about that file. Pass `message_id` and `key` " +
        "(as `file_key`) from the marker, set `resource_type` to `'image'` if `type=image` and `'file'` " +
        "otherwise, and pass the marker's `name` value as `original_filename` so directory-mode saves " +
        "use the original filename.\n\n" +
        "`save_to` must be an absolute path. If you pass a directory the original filename is appended; " +
        "if you pass a full file path it is used as-is. Parent directories are created automatically. " +
        "The 100 MB cap is enforced.",
      parameters: FeishuGetMessageFileSchema,
      async execute(_toolCallId: string, params: unknown) {
        const typed = params as FeishuGetMessageFileParams;
        try {
          return await withFeishuToolClient({
            api,
            toolName: "feishu_get_message_file",
            agentAccountId,
            agentId,
            asAccountId: typed.asAccountId,
            run: async ({ account }) => downloadAndSave(api, account, typed),
          });
        } catch (err) {
          return makeErrorResult(err instanceof Error ? err.message : String(err));
        }
      },
    })),
    { name: "feishu_get_message_file" },
  );

  api.logger.info?.("feishu_get_message_file: Registered feishu_get_message_file tool");
}
