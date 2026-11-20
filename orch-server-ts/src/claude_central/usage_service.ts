import type { ClaudeCentralAccountRepository } from "./account_repository.js";
import type { ClaudeCentralTokenRefreshService } from "./token_refresh_service.js";
import type { ClaudeCentralUsageObservation } from "./types.js";

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CENTRAL_USAGE_INTERVAL_MS = 4 * 60_000;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const USAGE_TIMEOUT_MS = 14_000;

export type ClaudeCentralUsageServiceOptions = {
  readonly repository: ClaudeCentralAccountRepository;
  readonly tokenRefresh: Pick<ClaudeCentralTokenRefreshService, "refreshAccount">;
  readonly fetch?: typeof fetch;
  readonly usageUrl?: string;
  readonly now?: () => number;
  readonly onCycleComplete?: () => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

export class ClaudeCentralUsageService {
  private readonly repository: ClaudeCentralAccountRepository;
  private readonly tokenRefresh: Pick<ClaudeCentralTokenRefreshService, "refreshAccount">;
  private readonly fetchImpl: typeof fetch;
  private readonly usageUrl: string;
  private readonly now: () => number;
  private readonly onCycleComplete?: () => void;
  private readonly onWarning?: (message: string, error?: unknown) => void;
  private readonly observations = new Map<string, ClaudeCentralUsageObservation>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: ClaudeCentralUsageServiceOptions) {
    this.repository = options.repository;
    this.tokenRefresh = options.tokenRefresh;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.usageUrl = options.usageUrl ?? ANTHROPIC_USAGE_URL;
    this.now = options.now ?? Date.now;
    this.onCycleComplete = options.onCycleComplete;
    this.onWarning = options.onWarning;
  }

  getObservation(accountId: string): ClaudeCentralUsageObservation | null {
    return this.observations.get(accountId) ?? null;
  }

  /** enabled && ok 계정의 사용량을 한 바퀴 관측한다. 결과는 메모리에만 둔다. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const accounts = await this.repository.list();
      for (const account of accounts) {
        if (!account.enabled || account.authState !== "ok") continue;
        if (account.accessToken === null) continue;
        await this.collectAccount(account.id, account.accessToken);
      }
    } catch (error) {
      this.warn("central Claude usage cycle failed", error);
    } finally {
      this.running = false;
    }
    this.onCycleComplete?.();
  }

  private async collectAccount(accountId: string, accessToken: string): Promise<void> {
    const first = await this.fetchUsage(accessToken);
    if (first.status === 401 || first.status === 403) {
      // 갱신 한 번. 거부되면 토큰 서비스가 needs_relogin(usage_rejected)으로 남긴다.
      const outcome = await this.tokenRefresh.refreshAccount(accountId, "usage_rejected");
      if (outcome.status !== "refreshed") return;
      const retry = await this.fetchUsage(outcome.account.accessToken ?? "");
      if (retry.status === 200) this.store(accountId, retry.body);
      return;
    }
    if (first.status === 200) this.store(accountId, first.body);
  }

  private store(accountId: string, body: unknown): void {
    this.observations.set(accountId, {
      raw: isRecord(body) ? body : null,
      fetched_at: new Date(this.now()).toISOString(),
    });
  }

  private async fetchUsage(
    accessToken: string,
  ): Promise<{ status: number; body: unknown }> {
    try {
      const response = await this.fetchImpl(this.usageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": CLAUDE_OAUTH_BETA,
          Accept: "application/json",
          "User-Agent": "soulstream-claude-account-pool/1.0",
        },
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });
      if (response.status !== 200) return { status: response.status, body: null };
      return { status: response.status, body: await response.json() };
    } catch (error) {
      this.warn("central Claude usage request failed", error);
      return { status: 0, body: null };
    }
  }

  start(intervalMs = CENTRAL_USAGE_INTERVAL_MS): void {
    if (this.timer !== undefined) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private warn(message: string, error?: unknown): void {
    try {
      this.onWarning?.(message, error);
    } catch {
      // 경고 통지 실패가 사용량 주기를 막지 않는다.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
