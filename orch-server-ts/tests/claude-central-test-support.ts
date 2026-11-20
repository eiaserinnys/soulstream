import type {
  ClaudeCentralAccountRepository,
  SaveRefreshedTokensInput,
  UpsertCentralLoginInput,
} from "../src/claude_central/account_repository.js";
import type {
  ClaudeCentralSettingsPatch,
  ClaudeCentralSettingsRepository,
} from "../src/claude_central/settings_repository.js";
import {
  applySettingsPatch,
  defaultCentralPoolSettings,
} from "../src/claude_central/settings_repository.js";
import type {
  ClaudeCentralAccountRecord,
  ClaudeCentralPoolSettings,
} from "../src/claude_central/types.js";

export const CENTRAL_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const CENTRAL_NOW_MS = Date.parse("2026-11-19T03:00:00.000Z");

export function centralAccountRecord(
  overrides: Partial<ClaudeCentralAccountRecord> = {},
): ClaudeCentralAccountRecord {
  return {
    id: CENTRAL_ACCOUNT_ID,
    email: "central@example.com",
    plan: "max",
    enabled: true,
    priority: 0,
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(CENTRAL_NOW_MS + 8 * 60 * 60_000).toISOString(),
    tokenLifetimeSec: 28_800,
    scopes: "user:profile",
    authState: "ok",
    reloginReason: null,
    refreshedAt: null,
    createdAt: new Date(CENTRAL_NOW_MS).toISOString(),
    updatedAt: new Date(CENTRAL_NOW_MS).toISOString(),
    ...overrides,
  };
}

/** SQL 저장소와 같은 뜻의 메모리 구현. 토큰은 그대로 둔다(암호화하지 않는다). */
export class InMemoryClaudeCentralAccountRepository implements ClaudeCentralAccountRepository {
  readonly accounts = new Map<string, ClaudeCentralAccountRecord>();

  constructor(seed: readonly ClaudeCentralAccountRecord[] = []) {
    for (const account of seed) this.accounts.set(account.id, { ...account });
  }

  async list(): Promise<ClaudeCentralAccountRecord[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  async findById(id: string): Promise<ClaudeCentralAccountRecord | null> {
    const account = this.accounts.get(id);
    return account === undefined ? null : { ...account };
  }

  async upsertLogin(input: UpsertCentralLoginInput): Promise<ClaudeCentralAccountRecord> {
    const existing = this.accounts.get(input.id);
    const record: ClaudeCentralAccountRecord = {
      id: input.id,
      email: input.email,
      plan: input.plan,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 0,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? existing?.refreshToken ?? null,
      expiresAt: input.expiresAt,
      tokenLifetimeSec: input.tokenLifetimeSec,
      scopes: input.scopes ?? existing?.scopes ?? null,
      authState: "ok",
      reloginReason: null,
      refreshedAt: input.nowIso,
      createdAt: existing?.createdAt ?? input.nowIso,
      updatedAt: input.nowIso,
    };
    this.accounts.set(record.id, record);
    return { ...record };
  }

  async updateSettings(
    id: string,
    patch: { readonly enabled?: boolean; readonly priority?: number },
    nowIso: string,
  ): Promise<ClaudeCentralAccountRecord | null> {
    const existing = this.accounts.get(id);
    if (existing === undefined) return null;
    const record: ClaudeCentralAccountRecord = {
      ...existing,
      enabled: patch.enabled ?? existing.enabled,
      priority: patch.priority ?? existing.priority,
      updatedAt: nowIso,
    };
    this.accounts.set(id, record);
    return { ...record };
  }

  async deleteById(id: string): Promise<boolean> {
    return this.accounts.delete(id);
  }

  async saveRefreshedTokens(
    input: SaveRefreshedTokensInput,
  ): Promise<ClaudeCentralAccountRecord | null> {
    const existing = this.accounts.get(input.id);
    if (existing === undefined) return null;
    const record: ClaudeCentralAccountRecord = {
      ...existing,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? existing.refreshToken,
      expiresAt: input.expiresAt,
      tokenLifetimeSec: input.tokenLifetimeSec ?? existing.tokenLifetimeSec,
      scopes: input.scopes ?? existing.scopes,
      refreshedAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.accounts.set(input.id, record);
    return { ...record };
  }

  async markNeedsRelogin(
    id: string,
    reason: string,
    nowIso: string,
  ): Promise<ClaudeCentralAccountRecord | null> {
    const existing = this.accounts.get(id);
    if (existing === undefined) return null;
    const record: ClaudeCentralAccountRecord = {
      ...existing,
      authState: "needs_relogin",
      reloginReason: reason,
      accessToken: null,
      updatedAt: nowIso,
    };
    this.accounts.set(id, record);
    return { ...record };
  }
}

export class InMemoryClaudeCentralSettingsRepository implements ClaudeCentralSettingsRepository {
  current: ClaudeCentralPoolSettings = defaultCentralPoolSettings();

  constructor(seed?: ClaudeCentralPoolSettings) {
    if (seed !== undefined) this.current = seed;
  }

  async read(): Promise<ClaudeCentralPoolSettings> {
    return { default_receive: this.current.default_receive, nodes: { ...this.current.nodes } };
  }

  async merge(patch: ClaudeCentralSettingsPatch): Promise<ClaudeCentralPoolSettings> {
    this.current = applySettingsPatch(this.current, patch);
    return this.read();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
