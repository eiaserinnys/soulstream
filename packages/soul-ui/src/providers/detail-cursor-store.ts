interface CursorEntry {
  value: number;
}

export interface DetailCursorStoreOptions {
  maxScopes?: number;
  maxSessionsPerScope?: number;
}

const DEFAULT_MAX_SCOPES = 8;
const DEFAULT_MAX_SESSIONS_PER_SCOPE = 100;

/** Provider-owned, bounded committed cursor cache. Map insertion order is the LRU. */
export class DetailCursorStore {
  private readonly maxScopes: number;
  private readonly maxSessionsPerScope: number;
  private readonly scopes = new Map<string, Map<string, CursorEntry>>();

  constructor(options: DetailCursorStoreOptions = {}) {
    this.maxScopes = positiveLimit(options.maxScopes, DEFAULT_MAX_SCOPES);
    this.maxSessionsPerScope = positiveLimit(
      options.maxSessionsPerScope,
      DEFAULT_MAX_SESSIONS_PER_SCOPE,
    );
  }

  get(scope: string, sessionKey: string): number {
    const sessions = this.scopes.get(scope);
    const entry = sessions?.get(sessionKey);
    if (!sessions || !entry) return 0;
    touchMapEntry(sessions, sessionKey, entry);
    touchMapEntry(this.scopes, scope, sessions);
    return entry.value;
  }

  commit(scope: string, sessionKey: string, cursor: number): number {
    if (!Number.isFinite(cursor) || cursor <= 0) {
      return this.get(scope, sessionKey);
    }

    let sessions = this.scopes.get(scope);
    if (!sessions) {
      sessions = new Map();
      this.scopes.set(scope, sessions);
    }
    const current = sessions.get(sessionKey)?.value ?? 0;
    const entry = { value: Math.max(current, cursor) };
    touchMapEntry(sessions, sessionKey, entry);
    trimOldest(sessions, this.maxSessionsPerScope);
    touchMapEntry(this.scopes, scope, sessions);
    trimOldest(this.scopes, this.maxScopes);
    return entry.value;
  }

  deleteSession(sessionKey: string): void {
    for (const [scope, sessions] of this.scopes) {
      sessions.delete(sessionKey);
      if (sessions.size === 0) this.scopes.delete(scope);
    }
  }

  clearScope(scope: string): void {
    this.scopes.delete(scope);
  }

  clearAll(): void {
    this.scopes.clear();
  }
}

const registeredStores = new Set<DetailCursorStore>();

export function createRegisteredDetailCursorStore(): DetailCursorStore {
  const store = new DetailCursorStore();
  registeredStores.add(store);
  return store;
}

export function clearAllDetailCursorStores(): void {
  for (const store of registeredStores) store.clearAll();
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function touchMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function trimOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
