import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type ObservedUserRecord = {
  entity: "user";
  accountId: string;
  idType: "open_id" | "union_id" | "user_id";
  idValue: string;
  names: string[];
  aliases: string[];
  sources: string[];
  agents: string[];
  sessionKeys: string[];
  sessionFiles: string[];
};

export type ObservedChatRecord = {
  entity: "chat";
  accountId: string;
  idType: "chat_id";
  idValue: string;
  names: string[];
  sources: string[];
  agents: string[];
  sessionKeys: string[];
  sessionFiles: string[];
};

export type ObservedIndex = {
  generatedAt: string;
  sourceRoots: string[];
  counts: {
    users: number;
    chats: number;
  };
  users: ObservedUserRecord[];
  chats: ObservedChatRecord[];
};

export type ObservedGroupSeed = {
  accountId: string;
  chatId: string;
  chatNames: string[];
  sessionKeys: string[];
  source: "shared-session";
};

const OPEN_ID_RE = /^ou_[a-z0-9]{32}$/i;
const UNION_ID_RE = /^on_[a-z0-9]{32}$/i;
const CHAT_ID_RE = /^oc_[a-z0-9]{32}$/i;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_SEARCH_LIMIT = 20;

function getOpenClawRoot(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  return override || path.join(os.homedir(), ".openclaw");
}

function getAgentsRoot(): string {
  return path.join(getOpenClawRoot(), "agents");
}

function getStorageDir(): string {
  return path.join(getOpenClawRoot(), "shared-knowledge", "feishu-id-index");
}

export function getObservedIndexPath(): string {
  return path.join(getStorageDir(), "observed-index.json");
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function cleanObservedName(name: unknown): string | null {
  const value = String(name || "").trim();
  if (!value) return null;
  if (value.startsWith("feishu:")) return null;
  if (value.startsWith("Cron:")) return null;
  if (value === "heartbeat") return null;
  if (OPEN_ID_RE.test(value) || UNION_ID_RE.test(value) || CHAT_ID_RE.test(value)) return null;
  return value;
}

function flattenContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const asRecord = item as Record<string, unknown>;
    if (typeof asRecord.text === "string") texts.push(asRecord.text);
    if (typeof asRecord.thinking === "string") texts.push(asRecord.thinking);
    if (asRecord.content) texts.push(flattenContentText(asRecord.content));
  }
  return texts.filter(Boolean).join("\n");
}

function mergeList(target: string[] | undefined, source: string[] | undefined): string[] {
  return unique([...(target || []), ...(source || [])]);
}

function createObservationStore() {
  return {
    users: new Map<string, ObservedUserRecord>(),
    chats: new Map<string, ObservedChatRecord>(),
  };
}

function upsertUserObservation(
  store: ReturnType<typeof createObservationStore>,
  observation: Omit<ObservedUserRecord, "entity">,
) {
  if (!observation.idValue || !observation.accountId) return;
  const key = `${observation.accountId}|${observation.idType}|${observation.idValue}`;
  const existing = store.users.get(key) || {
    entity: "user" as const,
    accountId: observation.accountId,
    idType: observation.idType,
    idValue: observation.idValue,
    names: [],
    aliases: [],
    sources: [],
    agents: [],
    sessionKeys: [],
    sessionFiles: [],
  };

  existing.names = mergeList(existing.names, observation.names);
  existing.aliases = mergeList(existing.aliases, observation.aliases);
  existing.sources = mergeList(existing.sources, observation.sources);
  existing.agents = mergeList(existing.agents, observation.agents);
  existing.sessionKeys = mergeList(existing.sessionKeys, observation.sessionKeys);
  existing.sessionFiles = mergeList(existing.sessionFiles, observation.sessionFiles);
  store.users.set(key, existing);
}

function upsertChatObservation(
  store: ReturnType<typeof createObservationStore>,
  observation: Omit<ObservedChatRecord, "entity" | "idType">,
) {
  if (!observation.idValue || !observation.accountId) return;
  const key = `${observation.accountId}|chat_id|${observation.idValue}`;
  const existing = store.chats.get(key) || {
    entity: "chat" as const,
    accountId: observation.accountId,
    idType: "chat_id" as const,
    idValue: observation.idValue,
    names: [],
    sources: [],
    agents: [],
    sessionKeys: [],
    sessionFiles: [],
  };

  existing.names = mergeList(existing.names, observation.names);
  existing.sources = mergeList(existing.sources, observation.sources);
  existing.agents = mergeList(existing.agents, observation.agents);
  existing.sessionKeys = mergeList(existing.sessionKeys, observation.sessionKeys);
  existing.sessionFiles = mergeList(existing.sessionFiles, observation.sessionFiles);
  store.chats.set(key, existing);
}

function pushTextObservation(
  hits: Array<{ idType: "open_id" | "union_id" | "user_id"; idValue: string; name: string | null; source: string }>,
  idType: "open_id" | "union_id" | "user_id",
  idValue: string,
  name: string | null,
  source: string,
) {
  if (!idValue || !name) return;
  hits.push({ idType, idValue, name, source });
}

function extractTextObservations(text: string) {
  const hits: Array<{
    idType: "open_id" | "union_id" | "user_id";
    idValue: string;
    name: string | null;
    source: string;
  }> = [];

  const senderRegex =
    /"sender_id"\s*:\s*"(ou_[a-z0-9]{32})"[\s\S]{0,200}?"sender"\s*:\s*"([^"]+)"/gi;
  for (const match of text.matchAll(senderRegex)) {
    pushTextObservation(hits, "open_id", match[1], cleanObservedName(match[2]), "transcript-sender");
  }

  const labelRegex = /"label"\s*:\s*"([^"]+?)\s*\((ou_[a-z0-9]{32})\)"/gi;
  for (const match of text.matchAll(labelRegex)) {
    pushTextObservation(hits, "open_id", match[2], cleanObservedName(match[1]), "transcript-label");
  }

  const atRegex = /<at user_id="(ou_[a-z0-9]{32})">([^<]+)<\/at>/gi;
  for (const match of text.matchAll(atRegex)) {
    pushTextObservation(hits, "open_id", match[1], cleanObservedName(match[2]), "transcript-mention");
  }

  const unionBeforeNameRegex =
    /"union_id"\s*:\s*"(on_[a-z0-9]{32})"[\s\S]{0,200}?"name"\s*:\s*"([^"]+)"/gi;
  for (const match of text.matchAll(unionBeforeNameRegex)) {
    pushTextObservation(hits, "union_id", match[1], cleanObservedName(match[2]), "transcript-union-id");
  }

  const unionAfterNameRegex =
    /"name"\s*:\s*"([^"]+)"[\s\S]{0,200}?"union_id"\s*:\s*"(on_[a-z0-9]{32})"/gi;
  for (const match of text.matchAll(unionAfterNameRegex)) {
    pushTextObservation(hits, "union_id", match[2], cleanObservedName(match[1]), "transcript-union-id");
  }

  const userBeforeNameRegex =
    /"user_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"[\s\S]{0,200}?"name"\s*:\s*"([^"]+)"/g;
  for (const match of text.matchAll(userBeforeNameRegex)) {
    if (OPEN_ID_RE.test(match[1]) || UNION_ID_RE.test(match[1]) || CHAT_ID_RE.test(match[1])) continue;
    pushTextObservation(hits, "user_id", match[1], cleanObservedName(match[2]), "transcript-user-id");
  }

  const userAfterNameRegex =
    /"name"\s*:\s*"([^"]+)"[\s\S]{0,200}?"user_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"/g;
  for (const match of text.matchAll(userAfterNameRegex)) {
    if (OPEN_ID_RE.test(match[2]) || UNION_ID_RE.test(match[2]) || CHAT_ID_RE.test(match[2])) continue;
    pushTextObservation(hits, "user_id", match[2], cleanObservedName(match[1]), "transcript-user-id");
  }

  return hits;
}

export async function buildObservedIndex(): Promise<ObservedIndex> {
  const store = createObservationStore();
  const sessionFiles = new Map<string, { agentId: string; accountId: string; sessionKey: string }>();
  let agentNames: string[];
  try {
    agentNames = await fs.readdir(getAgentsRoot());
  } catch {
    agentNames = [];
  }

  for (const agentId of agentNames) {
    const sessionsPath = path.join(getAgentsRoot(), agentId, "sessions", "sessions.json");
    let sessions: Record<string, any>;
    try {
      sessions = JSON.parse(await fs.readFile(sessionsPath, "utf8"));
    } catch {
      continue;
    }

    for (const [sessionKey, session] of Object.entries(sessions)) {
      const channel =
        session?.deliveryContext?.channel ||
        session?.lastChannel ||
        session?.origin?.surface ||
        null;
      const accountId =
        session?.deliveryContext?.accountId ||
        session?.lastAccountId ||
        session?.origin?.accountId ||
        null;
      const sessionFile = session?.sessionFile || null;
      const sessionNames = [cleanObservedName(session?.origin?.label)].filter(
        (value): value is string => Boolean(value),
      );

      if (accountId && channel === "feishu") {
        const directTo =
          session?.deliveryContext?.to ||
          session?.lastTo ||
          session?.origin?.to ||
          null;
        const groupCandidate =
          directTo?.startsWith("chat:")
            ? directTo.slice("chat:".length)
            : String(sessionKey).includes(":group:")
              ? String(sessionKey).split(":group:")[1]
              : null;
        const userCandidate =
          directTo?.startsWith("user:ou_")
            ? directTo.slice("user:".length)
            : String(sessionKey).includes(":direct:ou_")
              ? String(sessionKey).split(":direct:")[1]
              : null;

        if (userCandidate?.startsWith("ou_")) {
          upsertUserObservation(store, {
            accountId,
            idType: "open_id",
            idValue: userCandidate,
            names: sessionNames,
            aliases: sessionNames,
            sources: ["session-origin"],
            agents: [agentId],
            sessionKeys: [sessionKey],
            sessionFiles: sessionFile ? [sessionFile] : [],
          });
        }

        if (groupCandidate?.startsWith("oc_")) {
          upsertChatObservation(store, {
            accountId,
            idValue: groupCandidate,
            names: sessionNames,
            sources: ["session-origin"],
            agents: [agentId],
            sessionKeys: [sessionKey],
            sessionFiles: sessionFile ? [sessionFile] : [],
          });
        }
      }

      if (sessionFile && accountId) {
        sessionFiles.set(sessionFile, {
          agentId,
          accountId,
          sessionKey,
        });
      }
    }
  }

  for (const [sessionFile, meta] of sessionFiles.entries()) {
    try {
      await fs.access(sessionFile);
    } catch {
      continue;
    }

    const stream = createReadStream(sessionFile, "utf8");
    const input = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of input) {
      if (!line.trim()) continue;
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type !== "message") continue;
      const text = flattenContentText(parsed.message?.content || parsed.content || "");
      const senderLabel = parsed.message?.senderLabel || null;

      if (senderLabel) {
        const match = String(senderLabel).match(/^(.*?)\s*\((ou_[^)]+)\)$/);
        if (match) {
          const cleaned = cleanObservedName(match[1]);
          upsertUserObservation(store, {
            accountId: meta.accountId,
            idType: "open_id",
            idValue: match[2],
            names: cleaned ? [cleaned] : [],
            aliases: cleaned ? [cleaned] : [],
            sources: ["transcript-senderLabel"],
            agents: [meta.agentId],
            sessionKeys: [meta.sessionKey],
            sessionFiles: [sessionFile],
          });
        }
      }

      for (const hit of extractTextObservations(text)) {
        const aliases = [hit.name].filter((value): value is string => Boolean(value));
        upsertUserObservation(store, {
          accountId: meta.accountId,
          idType: hit.idType,
          idValue: hit.idValue,
          names: aliases,
          aliases,
          sources: [hit.source],
          agents: [meta.agentId],
          sessionKeys: [meta.sessionKey],
          sessionFiles: [sessionFile],
        });
      }
    }
  }

  const output: ObservedIndex = {
    generatedAt: new Date().toISOString(),
    sourceRoots: [getAgentsRoot()],
    counts: {
      users: store.users.size,
      chats: store.chats.size,
    },
    users: [...store.users.values()].sort((left, right) =>
      `${left.accountId}:${left.idValue}`.localeCompare(`${right.accountId}:${right.idValue}`),
    ),
    chats: [...store.chats.values()].sort((left, right) =>
      `${left.accountId}:${left.idValue}`.localeCompare(`${right.accountId}:${right.idValue}`),
    ),
  };

  await fs.mkdir(getStorageDir(), { recursive: true });
  await fs.writeFile(getObservedIndexPath(), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

export async function loadObservedIndex(forceRefresh = false): Promise<ObservedIndex> {
  if (forceRefresh) {
    return buildObservedIndex();
  }

  try {
    return JSON.parse(await fs.readFile(getObservedIndexPath(), "utf8")) as ObservedIndex;
  } catch {
    return buildObservedIndex();
  }
}

export function matchesObservedRecord(
  record: ObservedUserRecord | ObservedChatRecord,
  query: string,
): boolean {
  const needle = normalizeText(query);
  const haystack = unique([
    ...(record.names || []),
    ...("aliases" in record ? record.aliases : []),
    record.idValue,
    ...(record.sessionKeys || []),
  ]).map(normalizeText);
  return haystack.some((value) => value.includes(needle));
}

export function searchObserved(
  index: ObservedIndex,
  query: string,
  accountId?: string,
  limit = DEFAULT_SEARCH_LIMIT,
) {
  const users = index.users
    .filter((user) => (!accountId || user.accountId === accountId) && matchesObservedRecord(user, query))
    .slice(0, limit);

  const chats = index.chats
    .filter((chat) => (!accountId || chat.accountId === accountId) && matchesObservedRecord(chat, query))
    .slice(0, limit);

  return {
    query,
    account_id: accountId || null,
    observed_index_path: getObservedIndexPath(),
    observed_index_generated_at: index.generatedAt,
    users,
    chats,
  };
}

export function findObservedUsers(index: ObservedIndex, query: string, accountId?: string) {
  return index.users.filter(
    (user) => (!accountId || user.accountId === accountId) && matchesObservedRecord(user, query),
  );
}

export function deriveGroupSeeds(
  index: ObservedIndex,
  matches: ObservedUserRecord[],
): ObservedGroupSeed[] {
  const seeds = new Map<string, ObservedGroupSeed>();

  for (const user of matches) {
    for (const chat of index.chats) {
      if (chat.accountId !== user.accountId) continue;
      const sharedSessionKey = chat.sessionKeys.some((key) => user.sessionKeys.includes(key));
      const sharedSessionFile = chat.sessionFiles.some((file) => user.sessionFiles.includes(file));
      if (!sharedSessionKey && !sharedSessionFile) continue;
      const seedKey = `${chat.accountId}|${chat.idValue}`;
      const existing = seeds.get(seedKey) || {
        accountId: chat.accountId,
        chatId: chat.idValue,
        chatNames: [],
        sessionKeys: [],
        source: "shared-session" as const,
      };
      existing.chatNames = mergeList(existing.chatNames, chat.names);
      existing.sessionKeys = mergeList(existing.sessionKeys, chat.sessionKeys);
      seeds.set(seedKey, existing);
    }
  }

  return [...seeds.values()].sort((left, right) =>
    `${left.accountId}:${left.chatId}`.localeCompare(`${right.accountId}:${right.chatId}`),
  );
}

export function buildObservedCanonicalProfile(
  query: string,
  matches: ObservedUserRecord[],
  groupSeeds: ObservedGroupSeed[],
) {
  const openIdsByAccount: Record<string, string> = {};
  const unionIds = new Set<string>();
  const userIds = new Set<string>();
  const names = new Set<string>();
  const aliases = new Set<string>();

  for (const match of matches) {
    for (const name of match.names) names.add(name);
    for (const alias of match.aliases) aliases.add(alias);
    if (match.idType === "open_id") {
      openIdsByAccount[match.accountId] = match.idValue;
    } else if (match.idType === "union_id" && UNION_ID_RE.test(match.idValue)) {
      unionIds.add(match.idValue);
    } else if (match.idType === "user_id" && USER_ID_RE.test(match.idValue)) {
      userIds.add(match.idValue);
    }
  }

  return {
    query,
    names: [...names].sort((left, right) => left.localeCompare(right)),
    aliases: [...aliases].sort((left, right) => left.localeCompare(right)),
    open_ids_by_account: openIdsByAccount,
    union_ids: [...unionIds].sort((left, right) => left.localeCompare(right)),
    user_ids: [...userIds].sort((left, right) => left.localeCompare(right)),
    group_seeds: groupSeeds,
  };
}
