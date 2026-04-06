import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

type SessionStoreEntry = Record<string, unknown> & {
  sessionId?: string;
  sessionFile?: string;
  /** Accumulated history of all session files from prior rollovers. The
   *  current sessionFile is always appended here so tools like session
   *  transcript search can discover the full conversation lineage. */
  sessionFiles?: string[];
  chatType?: string;
  systemSent?: boolean;
};

type SessionStore = Record<string, SessionStoreEntry>;

const OPENCLAW_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function resolveAgentSessionsStorePath(agentId: string): string {
  return path.join(OPENCLAW_ROOT, "agents", agentId, "sessions", "sessions.json");
}

function findSessionStoreKey(store: SessionStore, sessionKey: string): string | null {
  if (store[sessionKey]) return sessionKey;
  const normalizedTarget = sessionKey.trim().toLowerCase();
  if (!normalizedTarget) return null;
  for (const candidateKey of Object.keys(store)) {
    if (candidateKey.trim().toLowerCase() === normalizedTarget) return candidateKey;
  }
  return null;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function rolloverStatelessGroupSession(params: {
  agentId: string;
  sessionKey: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const { agentId, sessionKey, log } = params;
  const storePath = resolveAgentSessionsStorePath(agentId);

  let storeRaw: string;
  try {
    storeRaw = await fs.readFile(storePath, "utf8");
  } catch (err) {
    log(`feishu: stateless rollover skipped for ${sessionKey}: failed reading ${storePath}: ${String(err)}`);
    return false;
  }

  let store: SessionStore;
  try {
    store = JSON.parse(storeRaw) as SessionStore;
  } catch (err) {
    log(`feishu: stateless rollover skipped for ${sessionKey}: invalid session store JSON: ${String(err)}`);
    return false;
  }

  const storeKey = findSessionStoreKey(store, sessionKey);
  if (!storeKey) {
    log(`feishu: stateless rollover skipped for ${sessionKey}: session key not found in store`);
    return false;
  }

  const entry = store[storeKey];
  if (!entry) {
    log(`feishu: stateless rollover skipped for ${sessionKey}: empty session entry`);
    return false;
  }

  if (entry.chatType !== "group") {
    return false;
  }

  const nextSessionId = randomUUID();
  const sessionsDir = entry.sessionFile ? path.dirname(entry.sessionFile) : path.dirname(storePath);
  const nextSessionFile = path.join(sessionsDir, `${nextSessionId}.jsonl`);
  // Preserve the outgoing sessionFile in a cumulative sessionFiles array so
  // session transcript search, milestone context, and other consumers can
  // discover the full conversation lineage across rollovers.
  const priorFiles: string[] = entry.sessionFiles?.length
    ? entry.sessionFiles
    : entry.sessionFile
      ? [entry.sessionFile]
      : [];
  const nextEntry: SessionStoreEntry = {
    ...entry,
    sessionId: nextSessionId,
    sessionFile: nextSessionFile,
    sessionFiles: [...priorFiles, nextSessionFile],
    updatedAt: Date.now(),
    systemSent: entry.systemSent === false ? false : true,
    abortedLastRun: false,
    compactionCount: 0,
    memoryFlushCompactionCount: undefined,
    memoryFlushAt: undefined,
    totalTokens: undefined,
    totalTokensFresh: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    modelProvider: undefined,
    model: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
  };

  store[storeKey] = nextEntry;

  try {
    await writeJsonAtomically(storePath, store);
  } catch (err) {
    log(`feishu: stateless rollover failed for ${sessionKey}: failed writing session store: ${String(err)}`);
    return false;
  }

  log(`feishu: stateless rollover applied for ${sessionKey} -> ${nextSessionId}`);
  return true;
}
