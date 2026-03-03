import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;

// Per-scope in-memory stores: scope -> Map<messageId, timestampMs>
const scopeStores = new Map<string, Map<string, number>>();

function resolveStateDirFromEnv(): string {
  const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `openclaw-vitest-${String(process.pid)}`);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveDedupFilePath(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDirFromEnv(), "feishu", "dedup", `${safe}.json`);
}

type DedupStore = Record<string, number>;

function loadStoreFromDisk(filePath: string): DedupStore {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? (parsed as DedupStore) : {};
  } catch {
    return {};
  }
}

function saveStoreToDisk(filePath: string, store: DedupStore): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store), "utf-8");
  } catch {
    // Disk errors are non-fatal: in-memory dedup still works.
  }
}

function pruneExpired(store: DedupStore, now: number): DedupStore {
  const entries = Object.entries(store).filter(([, ts]) => now - ts < DEDUP_TTL_MS);
  // If still over limit, keep only the newest FILE_MAX_ENTRIES entries
  if (entries.length > FILE_MAX_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.splice(FILE_MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

/**
 * Lazy-load the on-disk dedup store into the in-memory map for this scope.
 * Only runs once per scope per process lifetime.
 */
function getOrLoadScopeStore(scope: string): Map<string, number> {
  const existing = scopeStores.get(scope);
  if (existing) {
    return existing;
  }

  const memStore = new Map<string, number>();
  scopeStores.set(scope, memStore);

  // Load valid (non-expired) entries from disk
  const filePath = resolveDedupFilePath(scope);
  const diskData = loadStoreFromDisk(filePath);
  const now = Date.now();
  for (const [messageId, ts] of Object.entries(diskData)) {
    if (now - ts < DEDUP_TTL_MS) {
      memStore.set(messageId, ts);
    }
  }

  return memStore;
}

/**
 * Check-and-record a message ID for dedup purposes.
 *
 * Returns true  -> first time seeing this message (process it).
 * Returns false -> duplicate (skip it).
 *
 * Persistence: state is loaded from disk on first call per scope and flushed
 * back to disk on every new message, so dedup survives process restarts.
 *
 * @param messageId - Feishu message_id
 * @param scope     - Namespace key (defaults to "default"; use accountId to
 *                    isolate per-bot state)
 */
export function tryRecordMessage(messageId: string, scope = "default"): boolean {
  const now = Date.now();
  const memStore = getOrLoadScopeStore(scope);

  // Check in memory (covers both freshly-seen and disk-loaded entries)
  const cachedTs = memStore.get(messageId);
  if (cachedTs !== undefined && now - cachedTs < DEDUP_TTL_MS) {
    return false; // duplicate
  }

  // Record in memory
  memStore.set(messageId, now);

  // Evict expired entries from memory when the cache grows large
  if (memStore.size > MEMORY_MAX_SIZE * 2) {
    for (const [id, ts] of memStore) {
      if (now - ts >= DEDUP_TTL_MS) {
        memStore.delete(id);
      }
    }
    // If still over limit, evict the oldest entry
    if (memStore.size > MEMORY_MAX_SIZE * 2) {
      const oldest = memStore.keys().next().value;
      if (oldest !== undefined) {
        memStore.delete(oldest);
      }
    }
  }

  // Persist to disk: rebuild from current memory state, prune, and write
  const filePath = resolveDedupFilePath(scope);
  const diskStore: DedupStore = {};
  for (const [id, ts] of memStore) {
    diskStore[id] = ts;
  }
  saveStoreToDisk(filePath, pruneExpired(diskStore, now));

  return true; // new message
}
