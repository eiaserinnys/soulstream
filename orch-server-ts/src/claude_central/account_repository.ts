import type { LivePostgresSql } from "../runtime/live_db_sql.js";

import type { ClaudeCentralAccountRecord, ClaudeCentralAuthState } from "./types.js";

export type UpsertCentralLoginInput = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenLifetimeSec: number | null;
  readonly scopes: string | null;
  readonly nowIso: string;
};

export type SaveRefreshedTokensInput = {
  readonly id: string;
  readonly accessToken: string;
  /** null이면 기존 refresh_token을 유지한다. */
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenLifetimeSec: number | null;
  readonly scopes: string | null;
  readonly nowIso: string;
};

export type ClaudeCentralAccountRepository = {
  list(): Promise<ClaudeCentralAccountRecord[]>;
  findById(id: string): Promise<ClaudeCentralAccountRecord | null>;
  /** 같은 uuid면 토큰을 교체하고 auth_state를 ok로 되돌린다(재로그인). */
  upsertLogin(input: UpsertCentralLoginInput): Promise<ClaudeCentralAccountRecord>;
  updateSettings(
    id: string,
    patch: { readonly enabled?: boolean; readonly priority?: number },
    nowIso: string,
  ): Promise<ClaudeCentralAccountRecord | null>;
  deleteById(id: string): Promise<boolean>;
  saveRefreshedTokens(input: SaveRefreshedTokensInput): Promise<ClaudeCentralAccountRecord | null>;
  markNeedsRelogin(
    id: string,
    reason: string,
    nowIso: string,
  ): Promise<ClaudeCentralAccountRecord | null>;
};

type Row = Record<string, unknown>;

// 칸 목록은 조회마다 같은 이름을 쓴다. LivePostgresSql 타입에 unsafe가 없어
// 템플릿 안에 그대로 적는다.
export function createSqlClaudeCentralAccountRepository(options: {
  readonly resolveSql: () => Promise<LivePostgresSql>;
}): ClaudeCentralAccountRepository {
  return {
    async list() {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        SELECT id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
        FROM claude_central_accounts
        ORDER BY priority DESC, created_at ASC, id ASC
      `;
      return rows.map(accountRecord);
    },

    async findById(id) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        SELECT id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
        FROM claude_central_accounts
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0] === undefined ? null : accountRecord(rows[0]);
    },

    async upsertLogin(input) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        INSERT INTO claude_central_accounts (
          id, email, plan, access_token, refresh_token, expires_at,
          token_lifetime_sec, scopes, auth_state, relogin_reason, refreshed_at,
          updated_at
        )
        VALUES (
          ${input.id}, ${input.email}, ${input.plan}, ${input.accessToken},
          ${input.refreshToken}, ${input.expiresAt}, ${input.tokenLifetimeSec},
          ${input.scopes}, 'ok', NULL, ${input.nowIso}, ${input.nowIso}
        )
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          plan = EXCLUDED.plan,
          access_token = EXCLUDED.access_token,
          refresh_token = COALESCE(EXCLUDED.refresh_token, claude_central_accounts.refresh_token),
          expires_at = EXCLUDED.expires_at,
          token_lifetime_sec = EXCLUDED.token_lifetime_sec,
          scopes = COALESCE(EXCLUDED.scopes, claude_central_accounts.scopes),
          auth_state = 'ok',
          relogin_reason = NULL,
          refreshed_at = EXCLUDED.refreshed_at,
          updated_at = EXCLUDED.updated_at
        RETURNING id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
      `;
      return accountRecord(rows[0]);
    },

    async updateSettings(id, patch, nowIso) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        UPDATE claude_central_accounts
        SET enabled = COALESCE(${patch.enabled ?? null}, enabled),
            priority = COALESCE(${patch.priority ?? null}, priority),
            updated_at = ${nowIso}
        WHERE id = ${id}
        RETURNING id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
      `;
      return rows[0] === undefined ? null : accountRecord(rows[0]);
    },

    async deleteById(id) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        DELETE FROM claude_central_accounts WHERE id = ${id} RETURNING id
      `;
      return rows.length > 0;
    },

    async saveRefreshedTokens(input) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        UPDATE claude_central_accounts
        SET access_token = ${input.accessToken},
            refresh_token = COALESCE(${input.refreshToken}, refresh_token),
            expires_at = ${input.expiresAt},
            token_lifetime_sec = COALESCE(${input.tokenLifetimeSec}, token_lifetime_sec),
            scopes = COALESCE(${input.scopes}, scopes),
            refreshed_at = ${input.nowIso},
            updated_at = ${input.nowIso}
        WHERE id = ${input.id}
        RETURNING id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
      `;
      return rows[0] === undefined ? null : accountRecord(rows[0]);
    },

    async markNeedsRelogin(id, reason, nowIso) {
      const sql = await options.resolveSql();
      const rows = await sql<Row[]>`
        UPDATE claude_central_accounts
        SET auth_state = 'needs_relogin',
            relogin_reason = ${reason},
            access_token = NULL,
            updated_at = ${nowIso}
        WHERE id = ${id}
        RETURNING id::text AS id, email, plan, enabled, priority,
          access_token, refresh_token, expires_at, token_lifetime_sec, scopes,
          auth_state, relogin_reason, refreshed_at, created_at, updated_at
      `;
      return rows[0] === undefined ? null : accountRecord(rows[0]);
    },
  };
}

function accountRecord(row: Row | undefined): ClaudeCentralAccountRecord {
  if (row === undefined) throw new Error("claude_central_accounts statement returned no row");
  return {
    id: String(row.id),
    email: String(row.email),
    plan: nullableString(row.plan),
    enabled: row.enabled === true,
    priority: Number(row.priority ?? 0),
    accessToken: nullableString(row.access_token),
    refreshToken: nullableString(row.refresh_token),
    expiresAt: nullableIso(row.expires_at),
    tokenLifetimeSec: row.token_lifetime_sec === null || row.token_lifetime_sec === undefined
      ? null
      : Number(row.token_lifetime_sec),
    scopes: nullableString(row.scopes),
    authState: authState(row.auth_state),
    reloginReason: nullableString(row.relogin_reason),
    refreshedAt: nullableIso(row.refreshed_at),
    createdAt: isoValue(row.created_at) ?? "",
    updatedAt: isoValue(row.updated_at) ?? "",
  };
}

function authState(value: unknown): ClaudeCentralAuthState {
  return value === "needs_relogin" ? "needs_relogin" : "ok";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableIso(value: unknown): string | null {
  return isoValue(value);
}

function isoValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}
