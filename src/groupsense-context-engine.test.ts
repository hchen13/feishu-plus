import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "openclaw/plugin-sdk";
import {
  GroupSenseContextEngine,
  extractWarmStartCheckpoint,
} from "./groupsense-context-engine.js";

type AgentMessage = Parameters<ContextEngine["assemble"]>[0]["messages"][number];

function createConfig() {
  return {
    plugins: {
      slots: {
        contextEngine: "groupsense",
      },
    },
    channels: {
      feishu: {
        milestoneContext: {
          enabled: true,
        },
      },
    },
  };
}

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function assistantToolCall(name: string): AgentMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
    content: [
      { type: "thinking", thinking: "load startup context" },
      { type: "toolCall", id: `tool-${name}`, name, arguments: {} },
    ],
  };
}

function toolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError: false,
    timestamp: Date.now(),
    content: [{ type: "text", text }],
  };
}

function assistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    content: [{ type: "text", text }],
  };
}

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "feishu-groupsense-context-engine-"));
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("extractWarmStartCheckpoint", () => {
  it("keeps the pre-answer assistant/tool block and drops the user prompt plus final answer", () => {
    const readMemory = assistantToolCall("read_memory");
    const readMemoryResult = toolResult("tool-read_memory", "read_memory", "memory contents");
    const checkpoint = extractWarmStartCheckpoint([
      userMessage("help me with my resume"),
      readMemory,
      readMemoryResult,
      assistantText("I updated your resume"),
    ]);

    expect(checkpoint).toEqual([readMemory, readMemoryResult]);
  });
});

describe("GroupSenseContextEngine", () => {
  it("captures a warm-start checkpoint on the first real turn and reuses it for later turns in the same physical session", async () => {
    const storageDir = await makeTempDir();
    const delegateAssemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));
    const delegate: ContextEngine = {
      info: { id: "delegate", name: "Delegate Engine" },
      ingest: async () => ({ ingested: false }),
      assemble: delegateAssemble,
      compact: async () => ({ ok: true, compacted: false }),
    };

    const engine = new GroupSenseContextEngine({
      config: createConfig(),
      storageDir,
      delegate,
    });
    const sessionKey = "agent:main:feishu:group:oc-group";
    const sessionId = "session-1";
    const originalMessage = userMessage("original transcript message");
    const startupAssistant = assistantToolCall("read_memory");
    const startupToolResult = toolResult("tool-read_memory", "read_memory", "recent memory");

    const firstAssembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [originalMessage],
      prompt: "help me with my resume",
    });
    expect(firstAssembled.messages).toEqual([originalMessage]);
    expect(delegateAssemble).toHaveBeenCalledTimes(1);

    await engine.afterTurn?.({
      sessionId,
      sessionKey,
      sessionFile: "/tmp/session-1.jsonl",
      prePromptMessageCount: 0,
      messages: [
        userMessage("help me with my resume"),
        startupAssistant,
        startupToolResult,
        assistantText("done"),
      ],
    });

    const secondAssembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [
        userMessage("old turn should not be visible"),
        assistantText("old answer should not be visible"),
      ],
      prompt: "what happened next",
    });

    expect(secondAssembled.messages).toEqual([startupAssistant, startupToolResult]);
    expect(delegateAssemble).toHaveBeenCalledTimes(1);
  });

  it("invalidates the checkpoint when the physical session id changes", async () => {
    const storageDir = await makeTempDir();
    const delegateAssemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));
    const delegate: ContextEngine = {
      info: { id: "delegate", name: "Delegate Engine" },
      ingest: async () => ({ ingested: false }),
      assemble: delegateAssemble,
      compact: async () => ({ ok: true, compacted: false }),
    };

    const engine = new GroupSenseContextEngine({
      config: createConfig(),
      storageDir,
      delegate,
    });
    const sessionKey = "agent:main:feishu:group:oc-group";
    const freshMessage = userMessage("fresh real session");

    await engine.afterTurn?.({
      sessionId: "session-1",
      sessionKey,
      sessionFile: "/tmp/session-1.jsonl",
      prePromptMessageCount: 0,
      messages: [
        userMessage("hello"),
        assistantToolCall("read_memory"),
        toolResult("tool-read_memory", "read_memory", "recent memory"),
        assistantText("done"),
      ],
    });

    const assembled = await engine.assemble({
      sessionId: "session-2",
      sessionKey,
      messages: [freshMessage],
      prompt: "new turn",
    });

    expect(assembled.messages).toEqual([freshMessage]);
    expect(delegateAssemble).toHaveBeenCalledTimes(1);
  });
});
