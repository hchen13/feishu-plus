import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delegateCompactionToRuntime, type ContextEngine } from "openclaw/plugin-sdk";
import type { ClawdbotConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";

export const GROUPSENSE_CONTEXT_ENGINE_ID = "groupsense";

const GROUP_SESSION_MARKER = ":feishu:group:";
const DEFAULT_STORAGE_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "shared-knowledge",
  "feishu-groupsense-context-engine",
);
const MAX_CHECKPOINT_MESSAGES = 16;
const MAX_CHECKPOINT_CHARS = 48_000;
const STATE_VERSION = 1;

type AgentMessage = Parameters<ContextEngine["assemble"]>[0]["messages"][number];

type WarmStartState = {
  version: number;
  sessionId: string;
  sessionKey: string;
  capturedAt: number;
  checkpointMessages: AgentMessage[];
};

export type GroupSenseContextEngineOptions = {
  config?: ClawdbotConfig;
  storageDir?: string;
  delegate?: ContextEngine;
  logger?: {
    info?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

export function isGroupSenseContextEngineSelected(config?: ClawdbotConfig): boolean {
  return config?.plugins?.slots?.contextEngine === GROUPSENSE_CONTEXT_ENGINE_ID;
}

function isMilestoneContextEnabled(config?: ClawdbotConfig): boolean {
  return config?.channels?.feishu?.milestoneContext?.enabled !== false;
}

export function shouldUseStatelessGroupRollover(config?: ClawdbotConfig): boolean {
  return isMilestoneContextEnabled(config) && !isGroupSenseContextEngineSelected(config);
}

function shouldManageSession(config: ClawdbotConfig | undefined, sessionKey?: string): boolean {
  return isMilestoneContextEnabled(config) && typeof sessionKey === "string" && sessionKey.includes(GROUP_SESSION_MARKER);
}

function estimateTokens(messages: AgentMessage[]): number {
  const chars = JSON.stringify(messages).length;
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return JSON.parse(JSON.stringify(messages)) as AgentMessage[];
}

function messageCharSize(message: AgentMessage): number {
  return JSON.stringify(message).length;
}

function assistantHasVisibleText(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.content.some((item) => item.type === "text" && item.text.trim().length > 0);
}

function assistantHasBootstrapArtifacts(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.content.some((item) => item.type === "toolCall" || item.type === "thinking");
}

export function extractWarmStartCheckpoint(messages: AgentMessage[]): AgentMessage[] {
  const checkpoint: AgentMessage[] = [];
  let checkpointChars = 0;
  let sawAssistantBootstrap = false;

  for (const message of messages) {
    if (message.role === "user") {
      if (checkpoint.length > 0) break;
      continue;
    }

    if (message.role === "assistant") {
      if (assistantHasVisibleText(message)) break;
      if (!assistantHasBootstrapArtifacts(message)) {
        if (checkpoint.length > 0) break;
        continue;
      }
      sawAssistantBootstrap = true;
    } else if (message.role === "toolResult") {
      if (!sawAssistantBootstrap) continue;
    } else {
      if (checkpoint.length > 0) break;
      continue;
    }

    const nextChars = checkpointChars + messageCharSize(message);
    if (checkpoint.length >= MAX_CHECKPOINT_MESSAGES || nextChars > MAX_CHECKPOINT_CHARS) break;
    checkpoint.push(message);
    checkpointChars = nextChars;
  }

  return cloneMessages(checkpoint);
}

function stateFilePath(storageDir: string, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex");
  return path.join(storageDir, `${digest}.json`);
}

async function readWarmStartState(storageDir: string, sessionKey: string): Promise<WarmStartState | null> {
  const filePath = stateFilePath(storageDir, sessionKey);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WarmStartState>;
    if (
      parsed.version !== STATE_VERSION ||
      parsed.sessionKey !== sessionKey ||
      typeof parsed.sessionId !== "string" ||
      !Array.isArray(parsed.checkpointMessages)
    ) {
      return null;
    }
    return {
      version: parsed.version,
      sessionId: parsed.sessionId,
      sessionKey: parsed.sessionKey,
      capturedAt: typeof parsed.capturedAt === "number" ? parsed.capturedAt : 0,
      checkpointMessages: parsed.checkpointMessages as AgentMessage[],
    };
  } catch {
    return null;
  }
}

async function writeWarmStartState(
  storageDir: string,
  sessionKey: string,
  state: WarmStartState,
): Promise<void> {
  const filePath = stateFilePath(storageDir, sessionKey);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export class GroupSenseContextEngine implements ContextEngine {
  readonly info = {
    id: GROUPSENSE_CONTEXT_ENGINE_ID,
    name: "GroupSense Context Engine",
    version: "0.1.0",
  };

  private readonly config: ClawdbotConfig | undefined;
  private readonly storageDir: string;
  private readonly delegate: ContextEngine;
  private readonly logger: GroupSenseContextEngineOptions["logger"];

  constructor(options: GroupSenseContextEngineOptions = {}) {
    this.config = options.config;
    this.storageDir = options.storageDir ?? DEFAULT_STORAGE_DIR;
    this.logger = options.logger;
    this.delegate =
      options.delegate ??
      ({
        info: {
          id: "legacy",
          name: "Legacy Context Engine",
          version: "1.0.0",
        },
        ingest: async () => ({ ingested: false }),
        assemble: async (params) => ({
          messages: params.messages,
          estimatedTokens: 0,
        }),
        afterTurn: async () => {},
        compact: async (params) => await delegateCompactionToRuntime(params),
        dispose: async () => {},
      } satisfies ContextEngine);
  }

  async ingest(params: Parameters<ContextEngine["ingest"]>[0]) {
    return await this.delegate.ingest(params);
  }

  async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
    if (!shouldManageSession(this.config, params.sessionKey)) {
      return await this.delegate.assemble(params);
    }

    const sessionKey = params.sessionKey;
    if (!sessionKey) {
      return await this.delegate.assemble(params);
    }

    const state = await readWarmStartState(this.storageDir, sessionKey);
    if (!state || state.sessionId !== params.sessionId || state.checkpointMessages.length === 0) {
      const reason = !state
        ? "no-checkpoint"
        : state.sessionId !== params.sessionId
          ? `session-mismatch:${state.sessionId}`
          : "empty-checkpoint";
      this.logger?.info?.(
        `feishu[groupsense]: assemble delegate session=${sessionKey} reason=${reason}`,
      );
      return await this.delegate.assemble(params);
    }

    const messages = cloneMessages(state.checkpointMessages);
    this.logger?.info?.(
      `feishu[groupsense]: assemble checkpoint-hit session=${sessionKey} checkpointMessages=${messages.length} estimatedTokens=${estimateTokens(messages)}`,
    );
    return {
      messages,
      estimatedTokens: estimateTokens(messages),
    };
  }

  async afterTurn(params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) {
    await this.delegate.afterTurn?.(params);

    if (params.isHeartbeat || !shouldManageSession(this.config, params.sessionKey)) {
      return;
    }

    const sessionKey = params.sessionKey;
    if (!sessionKey) return;

    const state = await readWarmStartState(this.storageDir, sessionKey);
    if (state && state.sessionId === params.sessionId && state.checkpointMessages.length > 0) {
      return;
    }

    const turnMessages = params.messages.slice(params.prePromptMessageCount);
    const checkpointMessages = extractWarmStartCheckpoint(turnMessages);
    if (checkpointMessages.length === 0) return;

    await writeWarmStartState(this.storageDir, sessionKey, {
      version: STATE_VERSION,
      sessionId: params.sessionId,
      sessionKey,
      capturedAt: Date.now(),
      checkpointMessages,
    });
    this.logger?.info?.(
      `feishu[groupsense]: checkpoint captured session=${sessionKey} checkpointMessages=${checkpointMessages.length} estimatedTokens=${estimateTokens(checkpointMessages)}`,
    );
  }

  async compact(params: Parameters<ContextEngine["compact"]>[0]) {
    return await this.delegate.compact(params);
  }

  async dispose() {
    await this.delegate.dispose?.();
  }
}

export function registerGroupSenseContextEngine(api: OpenClawPluginApi): void {
  api.registerContextEngine(GROUPSENSE_CONTEXT_ENGINE_ID, () => {
    return new GroupSenseContextEngine({ config: api.config, logger: api.logger });
  });
}
