// 중앙 Claude 계정 풀 스냅샷의 해석 규칙. 오케스트레이터가 내려준
// `claude_central_pool_sync` payload를 노드가 읽는 방식만 담는다.
import { createHash } from "node:crypto";

import {
  emptyClaudeAccountUsage,
  parseAnthropicOAuthUsagePayload,
} from "./usage.js";
import type {
  ClaudeAccountUsage,
  ClaudeCentralPoolAccount,
  ClaudeCentralPoolSyncPayload,
} from "./types.js";

/** 이 여유 안에 만료되는 중앙 토큰은 후보로 쓰지 않는다. */
export const CENTRAL_TOKEN_MIN_VALIDITY_MS = 10 * 60_000;

/** 중앙 계정 인증 실패 뒤 그 (계정, 토큰) 쌍을 후보에서 빼 두는 시간. */
export const CENTRAL_AUTH_EXCLUSION_MS = 10 * 60_000;

export class ClaudeCentralPoolSyncError extends Error {
  readonly code = "INVALID_CENTRAL_POOL_SYNC";

  constructor(message: string) {
    super(message);
    this.name = "ClaudeCentralPoolSyncError";
  }
}

export function centralTokenFingerprint(token: string | null | undefined): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return createHash("sha256").update(token).digest("hex");
}

export function centralAccountUsage(account: ClaudeCentralPoolAccount): ClaudeAccountUsage {
  if (!account.usage_raw) {
    return emptyClaudeAccountUsage();
  }
  return parseAnthropicOAuthUsagePayload(account.usage_raw);
}

export function centralAccountExpiresAtMs(account: ClaudeCentralPoolAccount): number | null {
  if (!account.expires_at) {
    return null;
  }
  const parsed = Date.parse(account.expires_at);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 중앙 후보 조건 중 신선도 축: 켜져 있고, 인증 ok이며, 10분보다 오래 살아 있는 토큰. */
export function isCentralAccountFresh(
  account: ClaudeCentralPoolAccount,
  nowMs: number,
): boolean {
  if (!account.enabled || account.auth_state !== "ok") {
    return false;
  }
  if (typeof account.access_token !== "string" || account.access_token.length === 0) {
    return false;
  }
  const expiresAtMs = centralAccountExpiresAtMs(account);
  return expiresAtMs !== null && expiresAtMs > nowMs + CENTRAL_TOKEN_MIN_VALIDITY_MS;
}

export function normalizeCentralPoolSyncPayload(
  raw: unknown,
): ClaudeCentralPoolSyncPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClaudeCentralPoolSyncError("Central pool sync payload must be an object");
  }
  const record = raw as Record<string, unknown>;
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    throw new ClaudeCentralPoolSyncError("Central pool sync revision must be a finite number");
  }
  if (typeof record.receive !== "boolean") {
    throw new ClaudeCentralPoolSyncError("Central pool sync receive must be a boolean");
  }
  if (!Array.isArray(record.accounts)) {
    throw new ClaudeCentralPoolSyncError("Central pool sync accounts must be an array");
  }
  return {
    revision,
    receive: record.receive,
    accounts: record.accounts.map((account, index) =>
      normalizeCentralAccount(account, index)),
  };
}

function normalizeCentralAccount(raw: unknown, index: number): ClaudeCentralPoolAccount {
  const where = `Central pool sync accounts[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClaudeCentralPoolSyncError(`${where} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ClaudeCentralPoolSyncError(`${where}.id must be a non-empty string`);
  }
  if (typeof record.email !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.email must be a string`);
  }
  if (record.plan !== null && typeof record.plan !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.plan must be a string or null`);
  }
  if (typeof record.enabled !== "boolean") {
    throw new ClaudeCentralPoolSyncError(`${where}.enabled must be a boolean`);
  }
  const priority = record.priority;
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new ClaudeCentralPoolSyncError(`${where}.priority must be a finite number`);
  }
  if (record.auth_state !== "ok" && record.auth_state !== "needs_relogin") {
    throw new ClaudeCentralPoolSyncError(`${where}.auth_state must be ok or needs_relogin`);
  }
  if (record.relogin_reason !== null && typeof record.relogin_reason !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.relogin_reason must be a string or null`);
  }
  if (record.access_token !== null && typeof record.access_token !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.access_token must be a string or null`);
  }
  if (record.expires_at !== null && typeof record.expires_at !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.expires_at must be a string or null`);
  }
  if (
    record.usage_raw !== null
    && (typeof record.usage_raw !== "object" || Array.isArray(record.usage_raw))
  ) {
    throw new ClaudeCentralPoolSyncError(`${where}.usage_raw must be an object or null`);
  }
  if (record.usage_fetched_at !== null && typeof record.usage_fetched_at !== "string") {
    throw new ClaudeCentralPoolSyncError(`${where}.usage_fetched_at must be a string or null`);
  }
  return {
    id,
    email: record.email,
    plan: (record.plan as string | null) ?? null,
    enabled: record.enabled,
    priority,
    auth_state: record.auth_state,
    relogin_reason: (record.relogin_reason as string | null) ?? null,
    access_token: (record.access_token as string | null) ?? null,
    expires_at: (record.expires_at as string | null) ?? null,
    usage_raw: (record.usage_raw as Record<string, unknown> | null) ?? null,
    usage_fetched_at: (record.usage_fetched_at as string | null) ?? null,
  };
}
