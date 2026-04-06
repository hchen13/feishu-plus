/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  answerText: string;
  reasoningText: string;
  reasoningExpanded: boolean;
  /** Whether this card was opened with reasoning support enabled at all. */
  showReasoningPanel: boolean;
  /** Whether the collapsible reasoning panel has actually been inserted into
   * the live card. The panel is added lazily on the first reasoning event so
   * that users never see an empty "Reasoning" frame when the model produces
   * no thinking tokens (e.g. OpenAI models that only return encrypted
   * reasoning summaries, or trivial prompts the model short-circuits). */
  reasoningPanelAdded: boolean;
};

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: StreamingCardHeader;
  showReasoningPanel?: boolean;
};

const ANSWER_ELEMENT_ID = "content";
const REASONING_ELEMENT_ID = "reasoning_text";
const REASONING_PANEL_ELEMENT_ID = "reasoning_panel";
const REASONING_EMPTY_TEXT = "_No thoughts available._";
const THOUGHTS_EXPANDED_TITLE = "▾ Thoughts";
const THOUGHTS_COLLAPSED_TITLE = "▸ Thoughts";
const STREAMING_PLACEHOLDER_TEXT = "⏳ Thinking...";

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
  });
  if (!response.ok) {
    await release();
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  // Merge partial overlaps, e.g. "这" + "这是" => "这是".
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

export function resolveStreamingCardSendMode(options?: StreamingStartOptions) {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}

/** Reasoning panel element JSON, reused for both initial embedding (unused
 * now that the panel is lazy) and for runtime insertion via the Card Kit
 * `elements` POST API. */
function buildReasoningPanelElement(): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: REASONING_PANEL_ELEMENT_ID,
    expanded: true,
    background_color: "grey-50",
    padding: "4px 12px 12px 12px",
    vertical_spacing: "4px",
    header: {
      title: { tag: "plain_text", content: THOUGHTS_EXPANDED_TITLE },
      background_color: "grey-100",
      padding: "8px 12px 8px 12px",
    },
    elements: [
      {
        tag: "markdown",
        element_id: REASONING_ELEMENT_ID,
        content: "",
        text_size: "notation",
      },
    ],
  };
}

function buildStreamingCardJson(options?: StreamingStartOptions): Record<string, unknown> {
  // The reasoning panel is NEVER included in the initial card anymore, even
  // when showReasoningPanel is enabled. It is inserted lazily on the first
  // reasoning stream event (see ensureReasoningPanelAdded). This prevents
  // users from ever seeing an empty "Reasoning" frame when the model returns
  // no thinking tokens — which is the common case for OpenAI reasoning models
  // that only return encrypted reasoning summaries, or for trivial prompts
  // the model short-circuits.
  const elements: Record<string, unknown>[] = [];
  // Always seed the answer slot with a visible placeholder; the first answer
  // delta overwrites it.
  elements.push({
    tag: "markdown",
    element_id: ANSWER_ELEMENT_ID,
    content: STREAMING_PLACEHOLDER_TEXT,
  });

  const cardJson: Record<string, unknown> = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "[Generating...]" },
      streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
    },
    body: {
      elements,
    },
  };

  if (options?.header) {
    cardJson.header = {
      title: { tag: "plain_text", content: options.header.title },
      template: options.header.template ?? "blue",
    };
  }

  return cardJson;
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingAnswerText: string | null = null;
  private pendingReasoningText: string | null = null;
  private pendingReasoningExpanded: boolean | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = buildStreamingCardJson(options);

    // Create card entity
    const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.create",
    });
    if (!createRes.ok) {
      await releaseCreate();
      throw new Error(`Create card request failed with HTTP ${createRes.status}`);
    }
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    await releaseCreate();
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await this.client.im.message.reply({
        path: { message_id: sendOptions.replyToMessageId! },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else if (sendMode === "root_create") {
      // root_id is undeclared in the SDK types but accepted at runtime
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: "interactive", content: cardContent },
          { root_id: sendOptions.rootId },
        ),
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      answerText: "",
      reasoningText: "",
      reasoningExpanded: true,
      showReasoningPanel: options?.showReasoningPanel === true,
      reasoningPanelAdded: false,
    };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  private async requestCardApi(params: {
    path: string;
    method: "PATCH" | "PUT" | "POST";
    body: Record<string, unknown>;
    auditContext: string;
  }): Promise<void> {
    const apiBase = resolveApiBase(this.creds.domain);
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}${params.path}`,
      init: {
        method: params.method,
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params.body),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: params.auditContext,
    });
    if (!response.ok) {
      await release();
      throw new Error(`${params.auditContext} failed with HTTP ${response.status}`);
    }
    const data = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
    await release();
    if (typeof data.code === "number" && data.code !== 0) {
      throw new Error(`${params.auditContext} failed: ${data.msg || `code ${data.code}`}`);
    }
  }

  private async updateElementContent(
    elementId: string,
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<void> {
    if (!this.state) {
      return;
    }
    this.state.sequence += 1;
    await this.requestCardApi({
      path: `/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`,
      method: "PUT",
      body: {
        content: text,
        sequence: this.state.sequence,
        uuid: `s_${this.state.cardId}_${elementId}_${this.state.sequence}`,
      },
      auditContext: "feishu.streaming-card.update",
    }).catch((error) => onError?.(error));
  }

  private async patchElement(
    elementId: string,
    partialElement: Record<string, unknown>,
    onError?: (error: unknown) => void,
  ): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.state.sequence += 1;
    await this.requestCardApi({
      path: `/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}`,
      method: "PATCH",
      body: {
        partial_element: JSON.stringify(partialElement),
        sequence: this.state.sequence,
        uuid: `p_${this.state.cardId}_${elementId}_${this.state.sequence}`,
      },
      auditContext: "feishu.streaming-card.patch",
    }).catch((error) => onError?.(error));
  }

  /** Insert the reasoning collapsible panel into a live card, before the
   * answer element, exactly once. Subsequent calls are no-ops. Users should
   * only see a "Reasoning" frame when the model is actually producing
   * thinking content — never as a pre-allocated empty stub.  */
  private async ensureReasoningPanelAdded(): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    if (!this.state.showReasoningPanel || this.state.reasoningPanelAdded) {
      return;
    }
    this.state.reasoningPanelAdded = true;
    this.state.sequence += 1;
    try {
      await this.requestCardApi({
        path: `/cardkit/v1/cards/${this.state.cardId}/elements`,
        method: "POST",
        body: {
          type: "insert_before",
          target_element_id: ANSWER_ELEMENT_ID,
          elements: JSON.stringify([buildReasoningPanelElement()]),
          sequence: this.state.sequence,
          uuid: `a_${this.state.cardId}_reasoning_${this.state.sequence}`,
        },
        auditContext: "feishu.streaming-card.add-reasoning-panel",
      });
    } catch (error) {
      // Roll back the flag so a later call could retry — but log it so we
      // don't silently lose reasoning events.
      this.state.reasoningPanelAdded = false;
      this.log?.(`Add reasoning panel failed: ${String(error)}`);
    }
  }

  private async flushPendingUpdates(force = false): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastUpdateTime < this.updateThrottleMs) {
      return;
    }
    this.lastUpdateTime = now;

    const nextAnswerText = this.pendingAnswerText;
    const nextReasoningText = this.pendingReasoningText;
    const nextReasoningExpanded = this.pendingReasoningExpanded;
    if (
      nextAnswerText === null &&
      nextReasoningText === null &&
      nextReasoningExpanded === null
    ) {
      return;
    }
    this.pendingAnswerText = null;
    this.pendingReasoningText = null;
    this.pendingReasoningExpanded = null;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }

      // Reasoning element patches/content updates only make sense when the
      // panel has actually been inserted into the live card. Until then both
      // REASONING_PANEL_ELEMENT_ID and REASONING_ELEMENT_ID don't exist
      // server-side, so patching them would 404.
      if (
        this.state.reasoningPanelAdded &&
        nextReasoningExpanded !== null &&
        nextReasoningExpanded !== this.state.reasoningExpanded
      ) {
        this.state.reasoningExpanded = nextReasoningExpanded;
        await this.patchElement(
          REASONING_PANEL_ELEMENT_ID,
          {
            expanded: nextReasoningExpanded,
            header: {
              title: {
                tag: "plain_text",
                content: nextReasoningExpanded ? THOUGHTS_EXPANDED_TITLE : THOUGHTS_COLLAPSED_TITLE,
              },
              background_color: "grey-100",
              padding: "8px 12px 8px 12px",
            },
          },
          (e) => this.log?.(`Reasoning panel patch failed: ${String(e)}`),
        );
      }

      if (
        this.state.reasoningPanelAdded &&
        nextReasoningText !== null &&
        nextReasoningText !== this.state.reasoningText
      ) {
        this.state.reasoningText = nextReasoningText;
        await this.updateElementContent(REASONING_ELEMENT_ID, nextReasoningText, (e) =>
          this.log?.(`Reasoning update failed: ${String(e)}`),
        );
      }

      if (nextAnswerText !== null && nextAnswerText !== this.state.answerText) {
        this.state.answerText = nextAnswerText;
        await this.updateElementContent(ANSWER_ELEMENT_ID, nextAnswerText, (e) =>
          this.log?.(`Answer update failed: ${String(e)}`),
        );
      }
    });
    await this.queue;
  }

  async update(text: string): Promise<void> {
    return this.updateAnswer(text);
  }

  async updateAnswer(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const mergedInput = mergeStreamingText(this.pendingAnswerText ?? this.state.answerText, text);
    if (!mergedInput || mergedInput === this.state.answerText) {
      return;
    }
    this.pendingAnswerText = mergedInput;
    await this.flushPendingUpdates();
  }

  async updateReasoning(text: string): Promise<void> {
    if (!this.state || this.closed || !this.state.showReasoningPanel) {
      return;
    }
    // Reasoning callers feed us full formatted snapshots (see the detailed
    // note in reply-dispatcher.ts queueReasoningUpdate). Do NOT run these
    // through mergeStreamingText — the SDK formatter wraps each line in
    // `_..._`, so snapshot N+1 is not a strict prefix of snapshot N and the
    // merger's fallback branch concatenates them into a cascading chain.
    // Treat each incoming text as the authoritative full reasoning state.
    if (!text || text === this.state.reasoningText) {
      return;
    }
    // Lazy insertion: only add the reasoning panel to the card on the first
    // real reasoning arrival. This avoids the "empty Reasoning frame" UX
    // when the model returns no thinking tokens (OpenAI encrypted reasoning,
    // trivial prompts, etc.).
    await this.ensureReasoningPanelAdded();
    if (!this.state.reasoningPanelAdded) {
      // Panel insertion failed; skip the content update to avoid patching a
      // non-existent element. The failure was already logged.
      return;
    }
    this.pendingReasoningText = text;
    await this.flushPendingUpdates();
  }

  async collapseReasoning(): Promise<void> {
    if (!this.state || this.closed || !this.state.reasoningPanelAdded) {
      return;
    }
    if (
      this.pendingReasoningExpanded === false ||
      (this.pendingReasoningExpanded === null && this.state.reasoningExpanded === false)
    ) {
      return;
    }
    this.pendingReasoningExpanded = false;
    await this.flushPendingUpdates(true);
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    await this.queue;

    const pendingAnswerMerged = mergeStreamingText(
      this.state.answerText,
      this.pendingAnswerText ?? undefined,
    );
    const answerText = finalText ? mergeStreamingText(pendingAnswerMerged, finalText) : pendingAnswerMerged;

    this.pendingAnswerText = answerText;
    // Only finalize the reasoning panel if it was actually inserted during
    // the session. Without a physical panel, patching REASONING_ELEMENT_ID
    // would 404 server-side, and more importantly the UX goal is that users
    // never see an empty "Reasoning" frame — so we must not leave one behind
    // at close time either.
    if (this.state.reasoningPanelAdded) {
      const pendingReasoningMerged = mergeStreamingText(
        this.state.reasoningText,
        this.pendingReasoningText ?? undefined,
      );
      // If we reach close with the panel added but no pending content, still
      // fall back to the placeholder rather than leaving the element blank.
      // (Shouldn't normally happen — the panel is only added on non-empty
      // reasoning arrival — but keep it as a safety net.)
      const reasoningText = pendingReasoningMerged || REASONING_EMPTY_TEXT;
      this.pendingReasoningText = reasoningText;
      if (answerText && this.state.reasoningExpanded) {
        this.pendingReasoningExpanded = false;
      }
    }
    await this.flushPendingUpdates(true);

    // Close streaming mode
    this.state.sequence += 1;
    await this.requestCardApi({
      path: `/cardkit/v1/cards/${this.state.cardId}/settings`,
      method: "PATCH",
      body: {
        settings: JSON.stringify({
          config: { streaming_mode: false, summary: { content: truncateSummary(answerText) } },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      },
      auditContext: "feishu.streaming-card.close",
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.closed = true;
    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
