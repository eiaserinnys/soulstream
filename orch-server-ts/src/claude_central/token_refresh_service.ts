import { isRecord } from "@soulstream/wire-schema/json-record";
import { CLAUDE_OAUTH_TOKEN_URL } from "../node/node_claude_auth_helpers.js";

import type { ClaudeCentralAccountRepository } from "./account_repository.js";
import type { ClaudeCentralAccountRecord } from "./types.js";

export const CENTRAL_REFRESH_INTERVAL_MS = 60_000;
/** 갱신은 만료의 절반 수명 또는 이 하한 안으로 들어오면 한다. */
export const MIN_REFRESH_MARGIN_MS = 30 * 60_000;

export type ClaudeCentralRefreshOutcome =
  | { readonly status: "refreshed"; readonly account: ClaudeCentralAccountRecord }
  | { readonly status: "rejected"; readonly account: ClaudeCentralAccountRecord }
  | { readonly status: "skipped" }
  | { readonly status: "transient" };

export type ClaudeCentralTokenRefreshServiceOptions = {
  readonly repository: ClaudeCentralAccountRepository;
  readonly clientId: () => Promise<string> | string;
  readonly fetch?: typeof fetch;
  readonly tokenUrl?: string;
  readonly now?: () => number;
  readonly onRefreshed?: (account: ClaudeCentralAccountRecord) => void;
  readonly onRejected?: (account: ClaudeCentralAccountRecord) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

export function isCentralRefreshDue(
  account: Pick<
    ClaudeCentralAccountRecord,
    "enabled" | "authState" | "refreshToken" | "expiresAt" | "tokenLifetimeSec"
  >,
  nowMs: number,
): boolean {
  if (!account.enabled || account.authState !== "ok" || account.refreshToken === null) return false;
  if (account.expiresAt === null) return true;
  const expiresMs = Date.parse(account.expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  const lifetimeMs = Math.max(0, account.tokenLifetimeSec ?? 0) * 1_000;
  const thresholdMs = Math.max(lifetimeMs / 2, MIN_REFRESH_MARGIN_MS);
  return expiresMs - nowMs < thresholdMs;
}

export class ClaudeCentralTokenRefreshService {
  private readonly repository: ClaudeCentralAccountRepository;
  private readonly clientId: () => Promise<string> | string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenUrl: string;
  private readonly now: () => number;
  private readonly onRefreshed?: (account: ClaudeCentralAccountRecord) => void;
  private readonly onRejected?: (account: ClaudeCentralAccountRecord) => void;
  private readonly onWarning?: (message: string, error?: unknown) => void;
  private readonly inFlight = new Map<string, Promise<ClaudeCentralRefreshOutcome>>();
  private readonly warnedTransient = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: ClaudeCentralTokenRefreshServiceOptions) {
    this.repository = options.repository;
    this.clientId = options.clientId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tokenUrl = options.tokenUrl ?? CLAUDE_OAUTH_TOKEN_URL;
    this.now = options.now ?? Date.now;
    this.onRefreshed = options.onRefreshed;
    this.onRejected = options.onRejected;
    this.onWarning = options.onWarning;
  }

  /** due 계정을 한 바퀴 갱신한다. 계정 하나의 갱신은 프로세스 안에서 하나로 합친다. */
  async runOnce(): Promise<{ refreshed: number; rejected: number }> {
    if (this.running) return { refreshed: 0, rejected: 0 };
    this.running = true;
    try {
      const nowMs = this.now();
      const accounts = await this.repository.list();
      let refreshed = 0;
      let rejected = 0;
      for (const account of accounts) {
        if (!isCentralRefreshDue(account, nowMs)) continue;
        const outcome = await this.refreshAccount(account.id, "refresh_rejected");
        if (outcome.status === "refreshed") refreshed += 1;
        if (outcome.status === "rejected") rejected += 1;
      }
      return { refreshed, rejected };
    } finally {
      this.running = false;
    }
  }

  /**
   * 지정 계정을 지금 갱신한다(사용량 401/403에서 부른다).
   * 거부되면 relogin_reason을 usage_rejected로 남긴다.
   */
  refreshAccount(
    accountId: string,
    rejectionReason = "refresh_rejected",
  ): Promise<ClaudeCentralRefreshOutcome> {
    const existing = this.inFlight.get(accountId);
    if (existing !== undefined) return existing;
    const task = this.perform(accountId, rejectionReason).finally(() => {
      this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, task);
    return task;
  }

  start(intervalMs = CENTRAL_REFRESH_INTERVAL_MS): void {
    if (this.timer !== undefined) return;
    void this.runOnce().catch((error: unknown) => {
      this.warn("central Claude token refresh cycle failed", error);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.warn("central Claude token refresh cycle failed", error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async perform(
    accountId: string,
    rejectionReason: string,
  ): Promise<ClaudeCentralRefreshOutcome> {
    let account: ClaudeCentralAccountRecord | null;
    try {
      account = await this.repository.findById(accountId);
    } catch (error) {
      this.warn(`central Claude account lookup failed for ${accountId}`, error);
      return { status: "transient" };
    }
    if (
      account === null
      || !account.enabled
      || account.authState !== "ok"
      || account.refreshToken === null
    ) {
      return { status: "skipped" };
    }

    let response: Response;
    try {
      const clientId = await this.clientId();
      response = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          client_id: clientId,
        }),
      });
    } catch (error) {
      this.warnTransient(account, "central Claude token refresh request failed", error);
      return { status: "transient" };
    }

    if (response.status === 400 || response.status === 401) {
      const nowIso = new Date(this.now()).toISOString();
      const rejected = await this.repository.markNeedsRelogin(account.id, rejectionReason, nowIso);
      if (rejected === null) return { status: "transient" };
      this.onRejected?.(rejected);
      return { status: "rejected", account: rejected };
    }
    if (response.status !== 200) {
      this.warnTransient(
        account,
        `central Claude token refresh failed with HTTP ${response.status}`,
      );
      return { status: "transient" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.warnTransient(account, "central Claude token refresh returned invalid JSON");
      return { status: "transient" };
    }
    if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token.length === 0) {
      this.warnTransient(account, "central Claude token refresh returned no access_token");
      return { status: "transient" };
    }

    const nowMs = this.now();
    const expiresIn = body.expires_in;
    const nextLifetimeSec =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.trunc(expiresIn)
        : account.tokenLifetimeSec;
    const saved = await this.repository.saveRefreshedTokens({
      id: account.id,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
      expiresAt: nextLifetimeSec === null
        ? account.expiresAt
        : new Date(nowMs + nextLifetimeSec * 1_000).toISOString(),
      tokenLifetimeSec: nextLifetimeSec,
      scopes: typeof body.scope === "string" ? body.scope : null,
      nowIso: new Date(nowMs).toISOString(),
    });
    if (saved === null) return { status: "transient" };
    this.warnedTransient.delete(account.id);
    this.onRefreshed?.(saved);
    return { status: "refreshed", account: saved };
  }

  private warnTransient(
    account: ClaudeCentralAccountRecord,
    message: string,
    error?: unknown,
  ): void {
    if (this.warnedTransient.has(account.id)) return;
    this.warnedTransient.add(account.id);
    this.warn(`${message} (account ${account.id})`, error);
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.onWarning?.(message, error);
    } catch {
      // 경고 통지 실패가 갱신 주기를 막지 않는다.
    }
  }
}
