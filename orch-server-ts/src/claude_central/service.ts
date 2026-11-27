import type { ClaudeCentralPoolAccount } from "@soulstream/wire-schema";
import {
  effectiveWindowUsedPercent,
  isUsageExhaustedForScope,
} from "@soulstream/wire-schema/claude-account-usage";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { NodeRegistryEvent } from "../node/registry_types.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";

import type { ClaudeCentralAccountRepository } from "./account_repository.js";
import {
  ClaudeCentralLoginService,
  type ClaudeCentralLoginSnapshot,
} from "./login_service.js";
import { ClaudeCentralPoolSyncService, toPoolSyncAccount } from "./pool_sync_service.js";
import type { ClaudeCentralSettingsRepository } from "./settings_repository.js";
import { ClaudeCentralTokenRefreshService } from "./token_refresh_service.js";
import type {
  ClaudeCentralAccountList,
  ClaudeCentralAccountRecord,
  ClaudeCentralAccountView,
  ClaudeCentralEffectiveNode,
  ClaudeCentralPoolSettings,
  ClaudeCentralSettingsView,
} from "./types.js";
import { ClaudeCentralUsageService } from "./usage_service.js";
import {
  computeCentralPoolSummary,
  emptyCentralUsage,
  parseCentralUsagePayload,
} from "./usage_projection.js";

export type ClaudeCentralServiceOptions = {
  readonly repository: ClaudeCentralAccountRepository;
  readonly settingsRepository: ClaudeCentralSettingsRepository;
  readonly registry: InMemoryNodeRegistry;
  readonly bridge: Pick<SessionCommandTransportBridge, "sendPendingCommand">;
  readonly clientId: () => Promise<string> | string;
  readonly notifyRelogin: (alert: { accountId: string; accountEmail: string }) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  readonly usageIntervalMs?: number;
  /** 시험에서 Anthropic 호출을 가짜로 바꾼다. 테스트 밖에서는 생략한다. */
  readonly fetch?: typeof fetch;
};

/** A token that expires within this window may die before a one-shot call finishes. */
const ONE_SHOT_TOKEN_MIN_REMAINING_MS = 60_000;

export class ClaudeCentralNotFoundError extends Error {
  readonly code = "account_not_found";
  readonly statusCode = 404;

  constructor(message = "Claude 계정을 찾을 수 없습니다.") {
    super(message);
    this.name = "ClaudeCentralNotFoundError";
  }
}

export class ClaudeCentralService {
  readonly logins: ClaudeCentralLoginService;
  readonly refresh: ClaudeCentralTokenRefreshService;
  readonly usage: ClaudeCentralUsageService;
  readonly sync: ClaudeCentralPoolSyncService;

  private readonly repository: ClaudeCentralAccountRepository;
  private readonly settingsRepository: ClaudeCentralSettingsRepository;
  private readonly registry: InMemoryNodeRegistry;
  private readonly notifyRelogin: (alert: { accountId: string; accountEmail: string }) => void;
  private readonly onWarning?: (message: string, error?: unknown) => void;
  private readonly now: () => number;
  private readonly refreshIntervalMs?: number;
  private readonly usageIntervalMs?: number;
  private readonly notifiedNeedsRelogin = new Set<string>();

  constructor(options: ClaudeCentralServiceOptions) {
    this.repository = options.repository;
    this.settingsRepository = options.settingsRepository;
    this.registry = options.registry;
    this.notifyRelogin = options.notifyRelogin;
    this.onWarning = options.onWarning;
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs;
    this.usageIntervalMs = options.usageIntervalMs;

    this.sync = new ClaudeCentralPoolSyncService({
      registry: options.registry,
      bridge: options.bridge,
      settings: options.settingsRepository,
      listAccounts: () => this.listSyncAccounts(),
      now: this.now,
      onWarning: options.onWarning,
    });
    this.logins = new ClaudeCentralLoginService({
      repository: options.repository,
      clientId: options.clientId,
      now: this.now,
      onAccountLoggedIn: (account) => {
        this.notifiedNeedsRelogin.delete(account.id);
        void this.sync.sendAll();
      },
    });
    this.refresh = new ClaudeCentralTokenRefreshService({
      repository: options.repository,
      clientId: options.clientId,
      fetch: options.fetch,
      now: this.now,
      onRefreshed: () => { void this.sync.sendAll(); },
      onRejected: (account) => {
        this.handleReloginNeeded(account);
        void this.sync.sendAll();
      },
      onWarning: options.onWarning,
    });
    this.usage = new ClaudeCentralUsageService({
      repository: options.repository,
      tokenRefresh: this.refresh,
      fetch: options.fetch,
      now: this.now,
      onCycleComplete: () => { void this.sync.sendAll(); },
      onWarning: options.onWarning,
    });
  }

  start(): void {
    this.refresh.start(this.refreshIntervalMs);
    this.usage.start(this.usageIntervalMs);
  }

  stop(): void {
    this.refresh.stop();
    this.usage.stop();
    this.logins.close();
  }

  acceptNodeEvents(events: readonly NodeRegistryEvent[]): void {
    this.sync.acceptNodeEvents(events);
  }

  async getAccountList(): Promise<ClaudeCentralAccountList> {
    const nowMs = this.now();
    const records = await this.repository.list();
    const accounts = records.map((record) => this.accountView(record));
    const summaryAccounts = accounts.map((account) => ({
      id: account.id,
      enabled: account.enabled,
      auth_state: account.auth_state,
      usage: account.usage,
    }));
    return {
      mode: "pool",
      accounts,
      pool: computeCentralPoolSummary(summaryAccounts, "all", nowMs),
      fable_pool: computeCentralPoolSummary(summaryAccounts, "fable", nowMs),
    };
  }

  async patchAccount(
    accountId: string,
    patch: { readonly enabled?: boolean; readonly priority?: number },
  ): Promise<ClaudeCentralAccountList> {
    const updated = await this.repository.updateSettings(
      accountId,
      patch,
      new Date(this.now()).toISOString(),
    );
    if (updated === null) throw new ClaudeCentralNotFoundError();
    await this.sync.sendAll();
    return this.getAccountList();
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const deleted = await this.repository.deleteById(accountId);
    if (deleted) await this.sync.sendAll();
    return deleted;
  }

  async getSettings(): Promise<ClaudeCentralSettingsView> {
    return this.settingsView(await this.settingsRepository.read());
  }

  async updateSettings(input: {
    readonly default_receive?: boolean;
    readonly nodes?: Readonly<Record<string, boolean | null>>;
  }): Promise<ClaudeCentralSettingsView> {
    await this.settingsRepository.merge(input);
    await this.sync.sendAll();
    return this.getSettings();
  }

  startLogin(input: { account_id?: string } = {}): Promise<ClaudeCentralLoginSnapshot> {
    return this.logins.start(input);
  }

  submitLoginCode(loginId: string, code: string): Promise<ClaudeCentralLoginSnapshot> {
    return this.logins.submitCode(loginId, code);
  }

  getLogin(loginId: string): ClaudeCentralLoginSnapshot {
    return this.logins.status(loginId);
  }

  cancelLogin(loginId: string): ClaudeCentralLoginSnapshot {
    return this.logins.cancel(loginId);
  }

  /**
   * Access token for a one-shot `claude -p` call: the enabled, logged-in, unexhausted account
   * whose token stays valid for the next minute, preferring the lowest seven-day usage and then
   * the lowest five-hour usage. Null when no account qualifies.
   */
  async pickOneShotAccessToken(): Promise<string | null> {
    const nowMs = this.now();
    let best: { token: string; sevenDay: number; fiveHour: number } | undefined;
    for (const record of await this.repository.list()) {
      if (!record.enabled || record.authState !== "ok" || record.accessToken === null) continue;
      const expiresAtMs = record.expiresAt === null ? Number.NaN : Date.parse(record.expiresAt);
      if (!(expiresAtMs > nowMs + ONE_SHOT_TOKEN_MIN_REMAINING_MS)) continue;
      const observation = this.usage.getObservation(record.id);
      const usage = observation?.raw === null || observation?.raw === undefined
        ? emptyCentralUsage()
        : parseCentralUsagePayload(observation.raw);
      if (isUsageExhaustedForScope(usage, "all", nowMs)) continue;
      const candidate = {
        token: record.accessToken,
        sevenDay: effectiveWindowUsedPercent(usage.seven_day, nowMs) ?? 0,
        fiveHour: effectiveWindowUsedPercent(usage.five_hour, nowMs) ?? 0,
      };
      if (
        best === undefined ||
        candidate.sevenDay < best.sevenDay ||
        (candidate.sevenDay === best.sevenDay && candidate.fiveHour < best.fiveHour)
      ) {
        best = candidate;
      }
    }
    return best?.token ?? null;
  }

  private accountView(record: ClaudeCentralAccountRecord): ClaudeCentralAccountView {
    const observation = this.usage.getObservation(record.id);
    const usage = observation?.raw === null || observation?.raw === undefined
      ? emptyCentralUsage()
      : parseCentralUsagePayload(observation.raw);
    const loginExpiresAt = this.logins.activeLoginExpiresAt(record.id);
    return {
      id: record.id,
      email: record.email,
      plan: record.plan,
      enabled: record.enabled,
      priority: record.priority,
      auth_state: record.authState,
      ...(loginExpiresAt === undefined ? {} : { login_expires_at: loginExpiresAt }),
      usage,
      observed_at: observation?.fetched_at ?? null,
      blocked: null,
      active_sessions: 0,
    };
  }

  private async listSyncAccounts(): Promise<readonly ClaudeCentralPoolAccount[]> {
    const records = await this.repository.list();
    return records.map((record) => toPoolSyncAccount({
      record,
      observation: this.usage.getObservation(record.id),
    }));
  }

  private settingsView(settings: ClaudeCentralPoolSettings): ClaudeCentralSettingsView {
    const connected = new Set(this.registry.listConnectedNodes().map((node) => node.nodeId));
    const nodeIds = new Set<string>([...connected, ...Object.keys(settings.nodes)]);
    const effective: ClaudeCentralEffectiveNode[] = [...nodeIds]
      .sort((left, right) => left.localeCompare(right))
      .map((nodeId) => ({
        node_id: nodeId,
        receive: settings.nodes[nodeId] ?? settings.default_receive,
        connected: connected.has(nodeId),
      }));
    return {
      default_receive: settings.default_receive,
      nodes: { ...settings.nodes },
      effective,
    };
  }

  private handleReloginNeeded(account: ClaudeCentralAccountRecord): void {
    if (this.notifiedNeedsRelogin.has(account.id)) return;
    this.notifiedNeedsRelogin.add(account.id);
    try {
      this.notifyRelogin({ accountId: account.id, accountEmail: account.email });
    } catch (error) {
      try {
        this.onWarning?.("Claude central relogin notification failed", error);
      } catch {
        // 경고 통지 실패가 알림 상태를 되돌리지 않는다.
      }
    }
  }
}
