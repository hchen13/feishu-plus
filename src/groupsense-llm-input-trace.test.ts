import { describe, expect, it } from "vitest";
import {
  buildGroupSenseLlmInputTraceRecord,
  shouldInspectGroupSenseLlmInput,
  shouldTraceGroupSenseLlmInput,
} from "./groupsense-llm-input-trace.js";

describe("shouldInspectGroupSenseLlmInput", () => {
  it("remains active for Feishu group sessions even when trace dumping is off", () => {
    const config = {
      channels: {
        feishu: {
          milestoneContext: {
            enabled: true,
            llmInputTrace: {
              enabled: false,
            },
          },
        },
      },
    };

    expect(shouldInspectGroupSenseLlmInput(config, "agent:vera:feishu:group:oc-demo")).toBe(true);
    expect(shouldInspectGroupSenseLlmInput(config, "agent:vera:feishu:dm:ou-demo")).toBe(false);
  });
});

describe("shouldTraceGroupSenseLlmInput", () => {
  it("captures only when the trace is enabled for Feishu group sessions", () => {
    const config = {
      channels: {
        feishu: {
          milestoneContext: {
            llmInputTrace: {
              enabled: true,
            },
          },
        },
      },
    };

    expect(shouldTraceGroupSenseLlmInput(config, "agent:vera:feishu:group:oc-demo")).toBe(true);
    expect(shouldTraceGroupSenseLlmInput(config, "agent:vera:feishu:dm:ou-demo")).toBe(false);
    expect(
      shouldTraceGroupSenseLlmInput(
        {
          channels: {
            feishu: {
              milestoneContext: {
                llmInputTrace: {
                  enabled: false,
                },
              },
            },
          },
        },
        "agent:vera:feishu:group:oc-demo",
      ),
    ).toBe(false);
  });
});

describe("buildGroupSenseLlmInputTraceRecord", () => {
  it("includes the raw payload and a compact history summary", () => {
    const record = buildGroupSenseLlmInputTraceRecord({
      event: {
        runId: "run-123",
        sessionId: "session-123",
        provider: "openai-codex",
        model: "gpt-5.4",
        systemPrompt: "system",
        prompt: "user prompt",
        imagesCount: 0,
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "bootstrap" }] },
          { role: "user", content: [{ type: "text", text: "current turn" }] },
        ],
      },
      ctx: {
        sessionKey: "agent:vera:feishu:group:oc-demo",
        agentId: "vera",
        channelId: "feishu",
        trigger: "user",
      },
    });

    expect(record.sessionKey).toBe("agent:vera:feishu:group:oc-demo");
    expect(record.historySummary.count).toBe(2);
    expect(record.historySummary.roleCounts).toEqual({ assistant: 1, user: 1 });
    expect(record.historyMessages).toHaveLength(2);
    expect(record.prompt).toBe("user prompt");
  });
});
