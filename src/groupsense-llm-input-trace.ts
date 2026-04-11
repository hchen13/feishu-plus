import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";

const GROUP_SESSION_MARKER = ":feishu:group:";
const DEFAULT_TRACE_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "shared-knowledge",
  "feishu-groupsense-context-engine",
  "llm-input-traces",
);

export type GroupSenseLlmInputTraceConfig = {
  enabled?: boolean;
  outputDir?: string;
};

type TraceMessageSummary = {
  count: number;
  roleCounts: Record<string, number>;
  totalChars: number;
  maxMessageChars: number;
};

type LlmInputTraceEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

type LlmInputTraceContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

export function getGroupSenseLlmInputTraceConfig(
  config?: ClawdbotConfig,
): GroupSenseLlmInputTraceConfig | undefined {
  return config?.channels?.feishu?.milestoneContext?.llmInputTrace;
}

function isMilestoneContextEnabled(config?: ClawdbotConfig): boolean {
  return config?.channels?.feishu?.milestoneContext?.enabled !== false;
}

export function shouldInspectGroupSenseLlmInput(
  config: ClawdbotConfig | undefined,
  sessionKey?: string,
): boolean {
  return (
    isMilestoneContextEnabled(config) &&
    typeof sessionKey === "string" &&
    sessionKey.includes(GROUP_SESSION_MARKER)
  );
}

export function shouldTraceGroupSenseLlmInput(
  config: ClawdbotConfig | undefined,
  sessionKey?: string,
): boolean {
  const traceConfig = getGroupSenseLlmInputTraceConfig(config);
  return traceConfig?.enabled === true && shouldInspectGroupSenseLlmInput(config, sessionKey);
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function summarizeHistoryMessages(messages: unknown[]): TraceMessageSummary {
  const roleCounts: Record<string, number> = {};
  let totalChars = 0;
  let maxMessageChars = 0;

  for (const message of messages) {
    const messageChars = JSON.stringify(message).length;
    totalChars += messageChars;
    maxMessageChars = Math.max(maxMessageChars, messageChars);

    const role =
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      typeof (message as { role?: unknown }).role === "string"
        ? (message as { role: string }).role
        : "unknown";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }

  return {
    count: messages.length,
    roleCounts,
    totalChars,
    maxMessageChars,
  };
}

export function buildGroupSenseLlmInputTraceRecord(params: {
  event: LlmInputTraceEvent;
  ctx: LlmInputTraceContext;
}) {
  const { event, ctx } = params;
  return {
    capturedAt: new Date().toISOString(),
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    channelId: ctx.channelId,
    trigger: ctx.trigger,
    provider: event.provider,
    model: event.model,
    messageProvider: ctx.messageProvider,
    workspaceDir: ctx.workspaceDir,
    imagesCount: event.imagesCount,
    systemPrompt: event.systemPrompt,
    prompt: event.prompt,
    historySummary: summarizeHistoryMessages(event.historyMessages),
    historyMessages: event.historyMessages,
  };
}

function resolveTraceDir(config: GroupSenseLlmInputTraceConfig | undefined): string {
  const configured = config?.outputDir?.trim();
  return configured ? path.resolve(configured) : DEFAULT_TRACE_DIR;
}

function formatRoleCounts(roleCounts: Record<string, number>): string {
  const entries = Object.entries(roleCounts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "none";
  return entries.map(([role, count]) => `${role}:${count}`).join(",");
}

export function registerGroupSenseLlmInputTrace(api: OpenClawPluginApi): void {
  api.on("llm_input", async (event, ctx) => {
    if (!shouldInspectGroupSenseLlmInput(api.config, ctx.sessionKey)) return;

    const record = buildGroupSenseLlmInputTraceRecord({ event, ctx });
    const promptMarkers = [
      event.prompt.includes("【关键里程碑（历史摘要）】") ? "milestones" : null,
      event.prompt.includes("【近期消息（最近") ? "recent-window" : null,
      event.prompt.includes("Chat history since last reply") ? "chat-history" : null,
    ].filter(Boolean);
    api.logger.info?.(
      `feishu[groupsense]: llm_input session=${ctx.sessionKey ?? event.sessionId} model=${event.provider}/${event.model} promptChars=${event.prompt.length} systemChars=${event.systemPrompt?.length ?? 0} history=${record.historySummary.count} roles=${formatRoleCounts(record.historySummary.roleCounts)} markers=${promptMarkers.join(",") || "none"} trace=${shouldTraceGroupSenseLlmInput(api.config, ctx.sessionKey) ? "on" : "off"}`,
    );

    if (!shouldTraceGroupSenseLlmInput(api.config, ctx.sessionKey)) return;

    const traceConfig = getGroupSenseLlmInputTraceConfig(api.config);
    const traceDir = resolveTraceDir(traceConfig);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionPart = sanitizeFilePart(ctx.sessionKey ?? event.sessionId);
    const runPart = sanitizeFilePart(event.runId);
    const filePath = path.join(traceDir, `${timestamp}__${sessionPart}__${runPart}.json`);

    await fs.mkdir(traceDir, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    api.logger.info?.(`feishu[groupsense-trace]: wrote llm_input trace ${filePath}`);
  });
}
