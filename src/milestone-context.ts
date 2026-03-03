import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { HistoryEntry } from "openclaw/plugin-sdk";

export const MILESTONE_WINDOW = 48;
export const MILESTONE_KEEP = 5;

export type MilestoneDecision = {
  action: "append" | "skip";
  summary?: MilestoneSummary;
  reason?: string;
  fromMessageId?: string;
  toMessageId?: string;
};

export type MilestoneSummary = {
  objectives: string[];
  decisions: string[];
  todos: string[];
  risks: string[];
  nextSteps: string[];
  highlights: string[];
};

export type MilestoneRecord = {
  summary?: MilestoneSummary;
  fromMessageId: string;
  toMessageId: string;
  fromIndex: number;
  toIndex: number;
  messageCount: number;
  createdAt: number;
  triggerMessageId: string;
  triggerReason: "auto" | "explicit";
};

type MilestoneStore = {
  chatId: string;
  recentEntries: HistoryEntry[];
  milestones: MilestoneRecord[];
  lastIndex: number;
  state: {
    lastWindowStartMessageId: string;
    lastWindowEndMessageId: string;
  };
};

const STORAGE_DIR = path.join(os.homedir(), ".openclaw", "shared-knowledge", "feishu-group-milestones");

// Simple per-chatId write queue to prevent race conditions
const _writeQueues = new Map<string, Promise<void>>();

function enqueueWrite<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn);
  // Store a void-typed settled promise so the queue stays alive regardless of fn outcome
  _writeQueues.set(chatId, next.then(() => {}, () => {}));
  return next;
}

function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function milestonePath(chatId: string): string {
  return path.join(STORAGE_DIR, `${sanitizeChatId(chatId)}.json`);
}

function emptyStore(chatId: string): MilestoneStore {
  return {
    chatId,
    recentEntries: [],
    milestones: [],
    lastIndex: 0,
    state: {
      lastWindowStartMessageId: "",
      lastWindowEndMessageId: "",
    },
  };
}

function clampArray<T>(items: T[], maxLen: number): T[] {
  if (items.length <= maxLen) return items;
  return items.slice(items.length - maxLen);
}


function normalizeText(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").replace(/[`*_>#~\-]/g, "").trim();
}

function truncateText(text: string, maxLen = 140): string {
  const trimmed = text ?? "";
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}...`;
}

function pickUnique(list: string[], max = 3): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const k = item.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

function extractMilestoneFields(entries: HistoryEntry[]): MilestoneSummary {
  const draft: MilestoneSummary = {
    objectives: [],
    decisions: [],
    todos: [],
    risks: [],
    nextSteps: [],
    highlights: [],
  };

  for (const entry of entries) {
    const body = normalizeText(entry.body || "");
    if (!body) continue;
    const prefix = `${entry.sender ?? "unknown"}: ${truncateText(body, 180)}`;

    if (/目标|目标是|目标为|目的|本次讨论|这次我们|想(要|要做到|做)/i.test(body)) {
      draft.objectives.push(prefix);
    }

    if (/决定|结论|确认|最终|批准|冻结|统一|agree|确认下|结论是/i.test(body)) {
      draft.decisions.push(prefix);
    }

    if (/我会|你来|你们|我们来|下*一步|todo|待办|处理|实现|开发|补齐|补充|记录|总结|整理|测试|回归|跟进|部署|上线|做完|完成|分配|assign|执行/i.test(body)) {
      draft.todos.push(prefix);
    }

    if (/风险|阻塞|卡住|bug|报错|失败|冲突|依赖|受阻|异常|问题|不行|困难|超时|限流/i.test(body)) {
      draft.risks.push(prefix);
    }

    if (/下一步|后续|接下来|然后|然后再|之后|继续|下一轮|再来|后面/i.test(body)) {
      draft.nextSteps.push(prefix);
    }

    if (draft.objectives.length + draft.decisions.length + draft.risks.length + draft.nextSteps.length + draft.todos.length < 8) {
      draft.highlights.push(prefix);
    }
  }

  return {
    objectives: pickUnique(draft.objectives, 3),
    decisions: pickUnique(draft.decisions, 3),
    todos: pickUnique(draft.todos, 4),
    risks: pickUnique(draft.risks, 3),
    nextSteps: pickUnique(draft.nextSteps, 3),
    highlights: pickUnique(draft.highlights, 3),
  };
}

function extractSummaryFallback(entries: HistoryEntry[]): MilestoneSummary {
  const summary = extractMilestoneFields(entries);
  return {
    objectives: pickUnique(summary.objectives, 2),
    decisions: pickUnique(summary.decisions, 2),
    todos: pickUnique(summary.todos, 3),
    risks: pickUnique(summary.risks, 2),
    nextSteps: pickUnique(summary.nextSteps, 2),
    highlights: pickUnique(summary.highlights, 3),
  };
}

// Use the summarizer agent via gateway WebSocket protocol.
// callGateway is available in openclaw internals (not exported publicly),
// so we discover it dynamically from the dist directory.
type CallGatewayFn = (opts: {
  url?: string;
  token?: string;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
  mode?: string;
}) => Promise<Record<string, unknown>>;

let _callGateway: CallGatewayFn | null | "unset" = "unset";

async function resolveCallGateway(): Promise<CallGatewayFn | null> {
  if (_callGateway !== "unset") return _callGateway;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = createRequire(import.meta.url);
    const sdkPath = req.resolve("openclaw/plugin-sdk");
    // plugin-sdk resolves to dist/plugin-sdk/index.js;
    // call-*.js chunks live one level up in dist/, NOT in dist/plugin-sdk/
    const sdkDir = path.dirname(path.dirname(sdkPath));
    const files = (await fs.readdir(sdkDir)).filter((f) => /^call-[A-Za-z0-9_-]+\.js$/.test(f));
    for (const file of files) {
      try {
        // callGateway is exported as 'n' in the current build (openclaw 2026.x)
        const mod = (await import(`${sdkDir}/${file}`)) as Record<string, unknown>;
        const fn = mod["n"];
        if (typeof fn === "function") {
          _callGateway = fn as CallGatewayFn;
          console.log(`[milestone] resolved callGateway from ${file}`);
          return _callGateway;
        }
      } catch { /* try next file */ }
    }
  } catch (err) {
    console.warn(`[milestone] resolveCallGateway error: ${String(err)}`);
  }
  _callGateway = null;
  return null;
}

async function extractSummaryWithLLM(entries: HistoryEntry[]): Promise<MilestoneSummary> {
  const conversationText = entries
    .map((e) => `${e.sender ?? "unknown"}: ${(e.body ?? "").trim()}`)
    .join("\n");

  const callGateway = await resolveCallGateway();
  if (!callGateway) {
    console.warn("[milestone] callGateway unavailable, falling back to regex");
    return extractSummaryFallback(entries);
  }

  const sessionKey = `agent:summarizer:milestone-${randomUUID()}`;

  try {
    // 1. Send task to the summarizer agent
    const agentResp = (await callGateway({
      method: "agent",
      params: {
        message: `以下是群聊记录（共 ${entries.length} 条消息），请提取里程碑：\n\n${conversationText}`,
        sessionKey,
        thinking: "off",
        idempotencyKey: randomUUID(),
      },
      timeoutMs: 10_000,
      mode: "backend",
    })) as { runId?: string; status?: string };

    const runId = agentResp?.runId;
    if (!runId) throw new Error(`agent response missing runId: ${JSON.stringify(agentResp)}`);

    // 2. Wait for the summarizer to finish
    const waitResp = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: 60_000 },
      timeoutMs: 62_000,
      mode: "backend",
    })) as { status?: string };

    if (waitResp?.status !== "ok") {
      throw new Error(`summarizer did not complete: ${waitResp?.status}`);
    }

    // 3. Get the agent's JSON output from history
    const history = (await callGateway({
      method: "chat.history",
      params: { sessionKey, limit: 10 },
      timeoutMs: 10_000,
      mode: "backend",
    })) as { messages?: Array<{ role: string; content: unknown }> };

    const messages = history?.messages ?? [];
    const assistantMsg = messages.filter((m) => m.role === "assistant").at(-1);

    let rawContent = "";
    if (Array.isArray(assistantMsg?.content)) {
      for (const block of assistantMsg.content as Array<{ type: string; text?: string }>) {
        if (block.type === "text") rawContent += block.text ?? "";
      }
    } else if (typeof assistantMsg?.content === "string") {
      rawContent = assistantMsg.content;
    }

    const jsonStr = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonStr) as Partial<MilestoneSummary>;

    const toStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === "string").map((x) => String(x)) : [];

    return {
      objectives: toStringArray(parsed.objectives).slice(0, 3),
      decisions: toStringArray(parsed.decisions).slice(0, 3),
      todos: toStringArray(parsed.todos).slice(0, 4),
      risks: toStringArray(parsed.risks).slice(0, 3),
      nextSteps: toStringArray(parsed.nextSteps).slice(0, 3),
      highlights: [],
    };
  } catch (err) {
    console.warn(`[milestone] summarizer agent failed, falling back to regex: ${String(err)}`);
    return extractSummaryFallback(entries);
  } finally {
    // Best-effort cleanup of the temporary session
    void resolveCallGateway().then((cg) => {
      if (cg) {
        void cg({ method: "sessions.delete", params: { key: sessionKey }, timeoutMs: 5_000, mode: "backend" });
      }
    });
  }
}

function buildSummaryText(summary: MilestoneSummary, entries: HistoryEntry[]): string {
  const uniqSenders = Array.from(new Set(entries.map((entry) => entry.sender).filter(Boolean)));
  const senderText = uniqSenders.length > 0 ? uniqSenders.join("、") : "群成员";
  const lines: string[] = [];

  const addBlock = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`- ${title}：`);
    for (const item of items) {
      lines.push(`  - ${item}`);
    }
  };

  lines.push(`【群里程碑】${senderText} 在本窗口讨论 ${entries.length} 条消息`);
  addBlock("目标/背景", summary.objectives);
  addBlock("结论/决议", summary.decisions);
  addBlock("待办/动作", summary.todos);
  addBlock("后续步骤", summary.nextSteps);
  addBlock("阻塞/风险", summary.risks);

  if (lines.length === 1) {
    addBlock("关键讨论片段", summary.highlights);
  }

  return lines.join("\n");
}


async function readStore(chatId: string): Promise<MilestoneStore> {
  const filePath = milestonePath(chatId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      chatId,
      recentEntries: Array.isArray(parsed?.recentEntries) ? parsed.recentEntries : [],
      milestones: Array.isArray(parsed?.milestones) ? parsed.milestones : [],
      lastIndex: typeof parsed?.lastIndex === "number" ? parsed.lastIndex : 0,
      state: parsed?.state && typeof parsed.state === "object"
        ? {
            lastWindowStartMessageId: typeof parsed.state.lastWindowStartMessageId === "string" ? parsed.state.lastWindowStartMessageId : "",
            lastWindowEndMessageId: typeof parsed.state.lastWindowEndMessageId === "string" ? parsed.state.lastWindowEndMessageId : "",
          }
        : {
            lastWindowStartMessageId: "",
            lastWindowEndMessageId: "",
          },
    };
  } catch {
    return emptyStore(chatId);
  }
}

async function writeStore(store: MilestoneStore): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(milestonePath(store.chatId), JSON.stringify(store, null, 2), "utf-8");
}

export async function recordGroupMessageForMilestone(params: {
  chatId: string;
  messageId: string;
  sender: string;
  body: string;
}): Promise<void> {
  return enqueueWrite(params.chatId, async () => {
    const store = await readStore(params.chatId);

    const message: HistoryEntry = {
      messageId: params.messageId,
      sender: params.sender,
      body: params.body,
      timestamp: Date.now(),
    };

    const existed = store.recentEntries.findIndex((entry) => entry.messageId === params.messageId);
    if (existed >= 0) {
      store.recentEntries[existed] = message;
    } else {
      store.recentEntries.push(message);
      store.lastIndex += 1;
    }

    store.recentEntries = clampArray(store.recentEntries, MILESTONE_WINDOW);
    await writeStore(store);
  });
}

function windowBoundary(store: MilestoneStore): { from?: string; to?: string } {
  const first = store.recentEntries[0];
  const last = store.recentEntries[store.recentEntries.length - 1];
  return { from: first?.messageId, to: last?.messageId };
}

function hasDuplicateMilestone(store: MilestoneStore, fromMessageId: string, toMessageId: string): boolean {
  return store.milestones.some((item) => item.fromMessageId === fromMessageId && item.toMessageId === toMessageId);
}

export async function evaluateMilestoneForChat(params: {
  chatId: string;
  messageId: string;
}): Promise<MilestoneDecision> {
  return enqueueWrite(params.chatId, async () => {
    const store = await readStore(params.chatId);
    const { from, to } = windowBoundary(store);

    if (!from || !to) {
      return { action: "skip", reason: "no-window" };
    }

    if (store.recentEntries.length < MILESTONE_WINDOW) {
      return { action: "skip", reason: "insufficient" };
    }

    if (
      hasDuplicateMilestone(store, from, to) ||
      (store.state.lastWindowStartMessageId === from && store.state.lastWindowEndMessageId === to)
    ) {
      return { action: "skip", reason: "duplicate-window" };
    }

    const triggerReason: MilestoneRecord["triggerReason"] = "auto";

    const summary = await extractSummaryWithLLM(store.recentEntries);
    const record: MilestoneRecord = {
      summary,
      fromMessageId: from,
      toMessageId: to,
      fromIndex: Math.max(0, store.lastIndex - store.recentEntries.length + 1),
      toIndex: store.lastIndex,
      messageCount: store.recentEntries.length,
      createdAt: Date.now(),
      triggerMessageId: params.messageId,
      triggerReason,
    };

    store.milestones.push(record);
    store.milestones = clampArray(store.milestones, MILESTONE_KEEP);
    store.state.lastWindowStartMessageId = from;
    store.state.lastWindowEndMessageId = to;

    // Consume the current window after a successful summarize so the next window
    // starts fresh and avoids overlap-triggered duplicate appends.
    store.recentEntries = store.recentEntries.slice(MILESTONE_WINDOW);
    await writeStore(store);

    return {
      action: "append",
      fromMessageId: from,
      toMessageId: to,
    };
  });
}

export async function buildMilestonePrefix(chatId: string): Promise<string> {
  const store = await readStore(chatId);
  const recentMessages = clampArray(store.recentEntries, MILESTONE_WINDOW);
  const milestones = clampArray(store.milestones, MILESTONE_KEEP);

  const lines: string[] = [];

  if (milestones.length > 0) {
    lines.push("群里程碑（最近记录）：");
    milestones.forEach((item, idx) => {
      if (item.summary) {
        lines.push(`${idx + 1}. 里程碑 [${item.fromIndex}..${item.toIndex}, ${item.messageCount}条]`);
        for (const [k, vals] of Object.entries(item.summary)) {
          if (!Array.isArray(vals) || vals.length === 0) continue;
          const title = ({ objectives: "目标/背景", decisions: "结论/决议", todos: "待办/动作", risks: "阻塞/风险", nextSteps: "后续步骤", highlights: "关键片段" } as Record<string, string>)[k] ?? k;
          lines.push(`  - ${title}:`);
          for (const v of vals.slice(0, 3)) {
            lines.push(`    - ${v}`);
          }
        }
      } else {
        lines.push(
          `${idx + 1}. 里程碑 [${item.fromIndex}..${item.toIndex}, ${item.messageCount}条]`,
        );
      }
    });
    lines.push("");
  }

  if (recentMessages.length > 0) {
    lines.push(`最近 ${Math.min(recentMessages.length, MILESTONE_WINDOW)} 条消息:`);
    for (const msg of recentMessages) {
      lines.push(`${msg.sender}: ${msg.body}`);
    }
  }

  return lines.length ? lines.join("\n") : "";
}
