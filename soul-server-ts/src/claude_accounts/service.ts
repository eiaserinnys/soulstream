// Account lifecycle and pool operations share one store and session-activity contract.
import * as fs from "node:fs";
import type { Logger } from "pino";
import type { ClaudeProfileCredentialRenewer } from "./credential_renewal.js";
import { ClaudeAccountNotFoundError } from "./errors.js";
import {
  computeEarliestAvailableAt,
  computePoolSummary,
  pickBestAccountForScope,
} from "./pool.js";
import {
  countSelectableCandidates,
  getCredentialEligibleCandidates,
  isFableModel,
  projectPublicBlockView,
  selectBestCandidate,
  type SelectableAccountCandidate,
} from "./selector.js";
import { resolveRestrictedAccessToken } from "./restricted_credentials.js";
import { IsolationAuthUnavailableError } from "../runner/session_filesystem_errors.js";
import { ClaudeAccountStore } from "./store.js";
import { ClaudeAccountSessionActivity } from "./session_activity.js";
import {
  CENTRAL_AUTH_EXCLUSION_MS,
  centralAccountUsage,
  centralTokenFingerprint,
  isCentralAccountFresh,
  normalizeCentralPoolSyncPayload,
} from "./central_pool.js";
import type {
  ClaudeAccountAuthState,
  ClaudeAccountBlocksRecord,
  ClaudeAccountDeleteResult,
  ClaudeAccountAuthFailureInput,
  ClaudeAccountList,
  ClaudeAccountRecord,
  ClaudeAccountReloginReason,
  ClaudeAccountReloginRecord,
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionOptions,
  ClaudeAccountSelectionResponse,
  ClaudeAccountSelectionResult,
  ClaudeAccountSelectionWithCredential,
  ClaudeAccountUpdatePatch,
  ClaudeAccountView,
  ClaudeCentralPoolAccount,
  ClaudeLoginAccountPort,
} from "./types.js";
import {
  ClaudeAccountUsageCollector,
  isUnobservedObservation,
  type ClaudeAccountAuthOutcome,
  type CollectAccountUsageOptions,
} from "./usage.js";
import {
  UNMEASURED_LOCAL_USAGE_WAIT_MS,
  unmeasuredLocalWaitTargets,
  waitAtMost,
} from "./local_usage_wait.js";

export { ClaudeAccountNotFoundError } from "./errors.js";

export interface ClaudeAccountServiceOptions {
  credentialRenewer?: ClaudeProfileCredentialRenewer;
  accountsDir: string;
  homeDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  pollTtlMs?: number;
  concurrency?: number;
  perAccountTimeoutMs?: number;
  usageEndpointUrl?: string;
  logger?: Logger;
}

export class ClaudeAccountService implements ClaudeLoginAccountPort {
  readonly store: ClaudeAccountStore;
  readonly usageCollector: ClaudeAccountUsageCollector;
  private readonly now: () => number;
  private readonly credentialRenewer: ClaudeProfileCredentialRenewer | undefined;
  private readonly sessionActivity = new ClaudeAccountSessionActivity();
  private readonly loggingInExpiresAt = new Map<string, string>();
  private readonly logger: Logger | undefined;
  private readonly pendingRetireAccountIds = new Set<string>();
  /** 오케스트레이터가 마지막으로 적용한 중앙 풀 스냅샷(메모리 정본). */
  private centralRevision = 0;
  private centralAccounts: ClaudeCentralPoolAccount[] = [];
  /** 이 노드에서 실패한 (중앙 계정, 토큰 지문)을 잠시 후보에서 빼 두는 기억. */
  private readonly centralExclusions = new Map<
    string,
    { fingerprint: string; untilMs: number }
  >();

  constructor(options: ClaudeAccountServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.credentialRenewer = options.credentialRenewer;
    this.logger = options.logger;
    this.store = new ClaudeAccountStore({
      accountsDir: options.accountsDir,
      homeDir: options.homeDir,
    });
    this.usageCollector = new ClaudeAccountUsageCollector({
      fetchImpl: options.fetchImpl,
      now: this.now,
      endpointUrl: options.usageEndpointUrl,
      pollTtlMs: options.pollTtlMs,
      concurrency: options.concurrency,
      perAccountTimeoutMs: options.perAccountTimeoutMs,
      credentialRenewer: options.credentialRenewer,
      onAuthOutcome: (accountId, outcome) => this.applyAuthOutcome(accountId, outcome),
    });
    this.loadCentralSnapshot();
  }

  /**
   * 카드 #1734: 로컬 계정의 사용량 관측은 메모리에만 있어 재시작하면 비고, 오케스트레이터의 첫
   * 조회(약 5분 주기)가 올 때까지 로컬이 idle로 보여 늘 ok인 중앙이 이겼다. 서비스를 만든 뒤
   * 오케스트레이터 조회와 같은 길로 로컬 사용량을 한 번 잰다. 기다리지 않고 띄우며, 실패는
   * 경고 로그만 남기고 서비스 시작을 막지 않는다.
   */
  startLocalUsageWarmup(): void {
    void this.getAccountList().catch((err: unknown) => {
      this.logger?.warn({ err }, "Startup Claude account usage measurement failed");
    });
  }

  private loadCentralSnapshot(): void {
    try {
      const snapshot = this.store.readCentralSnapshot();
      if (!snapshot) return;
      const normalized = normalizeCentralPoolSyncPayload(snapshot);
      this.centralRevision = normalized.revision;
      this.centralAccounts = normalized.receive ? normalized.accounts : [];
    } catch (err) {
      this.logger?.warn({ err }, "Ignoring invalid central Claude pool snapshot on startup");
      this.centralRevision = 0;
      this.centralAccounts = [];
    }
  }

  /**
   * `claude_central_pool_sync` 적용. revision이 가진 것보다 작으면 버린다.
   * receive false이거나 accounts가 비면 중앙 계정을 모두 내린다.
   */
  applyCentralPoolSync(raw: unknown): { revision: number } {
    const payload = normalizeCentralPoolSyncPayload(raw);
    if (payload.revision < this.centralRevision) {
      return { revision: this.centralRevision };
    }
    this.centralRevision = payload.revision;
    this.centralAccounts = payload.receive ? payload.accounts : [];
    this.store.writeCentralSnapshot({
      revision: payload.revision,
      receive: payload.receive,
      accounts: this.centralAccounts,
    });
    const present = new Set(this.centralAccounts.map((account) => account.id));
    for (const accountId of [...this.centralExclusions.keys()]) {
      if (!present.has(accountId)) this.centralExclusions.delete(accountId);
    }
    this.logger?.info(
      {
        revision: payload.revision,
        receive: payload.receive,
        accounts: this.centralAccounts.length,
      },
      "Applied central Claude account pool snapshot",
    );
    return { revision: payload.revision };
  }

  private findCentralAccount(accountId: string): ClaudeCentralPoolAccount | undefined {
    return this.centralAccounts.find((account) => account.id === accountId);
  }

  private isCentralExcluded(account: ClaudeCentralPoolAccount, nowMs: number): boolean {
    const exclusion = this.centralExclusions.get(account.id);
    if (!exclusion) return false;
    if (exclusion.untilMs <= nowMs) {
      this.centralExclusions.delete(account.id);
      return false;
    }
    const fingerprint = centralTokenFingerprint(account.access_token);
    return fingerprint !== null && fingerprint === exclusion.fingerprint;
  }

  /** 중앙 계정 인증 실패를 relogin.json 대신 10분짜리 후보 제외로 기록한다. */
  private markCentralAuthFailure(accountId: string, tokenFingerprint?: string): void {
    const account = this.findCentralAccount(accountId);
    if (!account) return;
    const fingerprint =
      tokenFingerprint ?? centralTokenFingerprint(account.access_token);
    if (!fingerprint) return;
    this.centralExclusions.set(accountId, {
      fingerprint,
      untilMs: this.now() + CENTRAL_AUTH_EXCLUSION_MS,
    });
    this.logger?.warn(
      { accountId, untilMs: this.now() + CENTRAL_AUTH_EXCLUSION_MS },
      "Excluded central Claude account token after an authentication failure",
    );
  }

  private centralAccountView(
    account: ClaudeCentralPoolAccount,
    blocks: Record<string, ClaudeAccountBlocksRecord>,
    nowMs: number,
  ): ClaudeAccountView {
    return {
      id: account.id,
      email: account.email,
      plan: account.plan,
      enabled: account.enabled,
      priority: account.priority,
      auth_state: account.auth_state,
      login_expires_at: null,
      active_sessions: this.activeSessions(account.id),
      blocked: projectPublicBlockView(blocks[account.id], nowMs),
      stale: account.usage_raw === null,
      observed_at: account.usage_fetched_at,
      usage: centralAccountUsage(account),
      source: "central",
    };
  }

  private isCredentialExcluded(
    account: ClaudeCentralPoolAccount,
    excludeCredentials: ClaudeAccountSelectionInput["exclude_credentials"],
  ): boolean {
    if (!excludeCredentials || excludeCredentials.length === 0) return false;
    const fingerprint = centralTokenFingerprint(account.access_token);
    if (!fingerprint) return false;
    return excludeCredentials.some(
      (entry) =>
        entry.account_id === account.id && entry.token_fingerprint === fingerprint,
    );
  }

  private applyAuthOutcome(accountId: string, outcome: ClaudeAccountAuthOutcome): void {
    // 중앙 계정은 이 노드가 자격을 갱신하지 않는다. relogin도 남기지 않는다.
    if (this.findCentralAccount(accountId)) return;
    if (outcome === "renew_failed") this.markNeedsRelogin(accountId, "renewal_failed");
    else if (outcome === "rejected") this.markNeedsRelogin(accountId, "usage_rejected");
    else this.clearNeedsRelogin(accountId);
  }

  /** 이미 기록이 있으면 첫 관측을 유지한다. */
  markNeedsRelogin(accountId: string, reason: ClaudeAccountReloginReason): void {
    // 중앙 계정의 인증 상태는 오케스트레이터가 관리한다.
    if (this.findCentralAccount(accountId)) return;
    const relogin = this.store.readRelogin();
    if (accountId in relogin) return;
    relogin[accountId] = {
      reason,
      observed_at: new Date(this.now()).toISOString(),
    };
    this.store.writeRelogin(relogin);
    this.logger?.warn({ accountId, reason }, "Claude account needs relogin");
  }

  private clearNeedsRelogin(accountId: string): void {
    const relogin = this.store.readRelogin();
    if (!(accountId in relogin)) return;
    delete relogin[accountId];
    this.store.writeRelogin(relogin);
    this.logger?.info({ accountId }, "Claude account relogin state cleared");
  }

  async reportAuthFailure(input: ClaudeAccountAuthFailureInput): Promise<void> {
    if (this.findCentralAccount(input.account_id)) {
      // 중앙 계정은 relogin.json 대신 (계정, 토큰 지문)을 잠시 후보에서 뺀다.
      this.markCentralAuthFailure(input.account_id, input.token_fingerprint);
      return;
    }
    if (!this.store.readAccounts().some((acc) => acc.id === input.account_id)) return;
    this.markNeedsRelogin(input.account_id, "session_auth_failed");
  }

  activeSessions(accountId: string): number {
    return this.sessionActivity.activeSessions(accountId);
  }

  profileDir(accountId: string): string | null {
    const dir = this.store.profileDir(accountId);
    if (fs.existsSync(dir)) return dir;
    const existsInAccounts = this.store.readAccounts().some((acc) => acc.id === accountId);
    return existsInAccounts ? dir : null;
  }

  async createPendingDir(loginId: string): Promise<string> {
    return this.store.createPendingDir(loginId);
  }

  async retirePending(loginId: string): Promise<void> {
    this.store.retirePendingDir(loginId);
  }

  async findAccount(
    accountId: string,
  ): Promise<{ id: string; email: string | null } | null> {
    const found = this.store.readAccounts().find((acc) => acc.id === accountId);
    if (!found) return null;
    return { id: found.id, email: found.email || null };
  }

  async findByIdentity(input: {
    id: string;
    email: string | null;
  }): Promise<{ id: string } | null> {
    const accounts = this.store.readAccounts();
    const byId = accounts.find((acc) => acc.id === input.id);
    if (byId) return { id: byId.id };
    const normalizedEmail = input.email?.trim().toLowerCase();
    if (!normalizedEmail) return null;
    const byEmail = accounts.find(
      (acc) => acc.email.trim().toLowerCase() === normalizedEmail,
    );
    return byEmail ? { id: byEmail.id } : null;
  }

  async registerFromPending(input: {
    loginId: string;
    id: string;
    email: string | null;
    plan: string | null;
  }): Promise<void> {
    this.store.promotePendingToProfile({
      loginId: input.loginId,
      accountUuid: input.id,
    });

    const nowIso = new Date(this.now()).toISOString();
    const accounts = this.store.readAccounts();
    const existingByUuid = accounts.find((acc) => acc.id === input.id);

    const record: ClaudeAccountRecord = {
      id: input.id,
      email: input.email ?? existingByUuid?.email ?? "",
      plan: input.plan ?? existingByUuid?.plan ?? null,
      enabled: existingByUuid ? existingByUuid.enabled : true,
      priority: existingByUuid ? existingByUuid.priority : null,
      created_at: existingByUuid ? existingByUuid.created_at : nowIso,
    };

    const nextAccounts = accounts.filter((acc) => acc.id !== input.id);
    nextAccounts.push(record);
    this.store.writeAccounts(nextAccounts);

    this.loggingInExpiresAt.delete(input.id);
    this.clearNeedsRelogin(input.id);
    this.pendingRetireAccountIds.delete(input.id);
  }

  async beginRelogin(accountId: string, expiresAt: string): Promise<void> {
    this.loggingInExpiresAt.set(accountId, expiresAt);
  }

  async endRelogin(
    accountId: string,
    outcome: "ok" | "needs_relogin",
  ): Promise<void> {
    this.loggingInExpiresAt.delete(accountId);
    if (outcome === "ok") {
      this.clearNeedsRelogin(accountId);
      this.store.ensureProfileSymlinks(accountId);
    } else if (outcome === "needs_relogin") {
      this.markNeedsRelogin(accountId, "login_failed");
    }
  }

  private resolveEffectiveAuthState(
    accountId: string,
    observedState: "ok" | "idle",
    relogin: Record<string, ClaudeAccountReloginRecord>,
  ): ClaudeAccountAuthState {
    if (this.loggingInExpiresAt.has(accountId)) return "logging_in";
    if (accountId in relogin) return "needs_relogin";
    return observedState;
  }

  async select(
    input: ClaudeAccountSelectionInput,
    options: ClaudeAccountSelectionOptions = {},
  ): Promise<ClaudeAccountSelectionResponse | ClaudeAccountSelectionWithCredential> {
    let nowMs = this.now();
    let pool = this.buildSelectionPool(input, nowMs);

    // 카드 #1734: 재시작 직후에는 로컬 사용량 관측이 비어 로컬이 idle로 보이고, 늘 ok인 중앙이
    // ok>idle 규칙으로 이겼다. 아직 한 번도 재지 않은 적격 로컬이 있으면 그 측정(시작 측정이나
    // 오케스트레이터 조회가 돌고 있으면 거기에 합류)을 짧은 상한까지 기다린 뒤 후보를 다시 만든다.
    const waitTargets = unmeasuredLocalWaitTargets({
      candidates: pool.candidates,
      unmeasuredLocalIds: pool.unmeasuredLocalIds,
      profileDir: (accountId) => this.store.profileDir(accountId),
      model: input.model,
      boundAccountId: pool.boundAccountId,
      boundTurnId: pool.boundTurnId,
      turnId: input.turn_id,
      excludeIds: input.exclude_ids,
      nowMs,
    });
    if (waitTargets.length > 0) {
      const measured = this.usageCollector.collectAll(waitTargets).catch((err: unknown) => {
        this.logger?.warn({ err }, "Claude account usage measurement before selection failed");
      });
      await waitAtMost(measured, UNMEASURED_LOCAL_USAGE_WAIT_MS);
      nowMs = this.now();
      pool = this.buildSelectionPool(input, nowMs);
    }

    const {
      bindings,
      blocks,
      centralById,
      centralTokens,
      candidates,
      existingBinding,
      boundAccountId,
      boundTurnId,
    } = pool;

    // restricted(격리) Claude는 접근 토큰을 낼 수 있는 계정만 후보로 삼는다.
    // 자격이 없는 후보는 이 선택에서 탈락하고, 남은 후보가 없으면 CLI를
    // 띄우기 전에 닫힌다(fail-closed).
    let accessTokens: Map<string, string> | null = null;
    let selectionCandidates = candidates;
    if (options.requireAccessTokenCredential === true) {
      const credentialEligible = getCredentialEligibleCandidates({
        candidates,
        model: input.model,
        excludeIds: input.exclude_ids,
        nowMs,
      });
      const tokens = new Map<string, string>();
      for (const candidate of credentialEligible) {
        const centralToken = centralTokens.get(candidate.id);
        if (centralToken) {
          tokens.set(candidate.id, centralToken);
          continue;
        }
        const token = await resolveRestrictedAccessToken({
          accountId: candidate.id,
          profileDir: this.store.profileDir(candidate.id),
        }, {
          ...(this.credentialRenewer
            ? { credentialRenewer: this.credentialRenewer }
            : {}),
          now: this.now,
        });
        if (token !== null) tokens.set(candidate.id, token);
      }
      if (tokens.size === 0) {
        throw new IsolationAuthUnavailableError(
          "격리 Claude에서 사용할 수 있는 계정 자격이 없습니다. 호스트 자격 갱신에 실패했습니다.",
        );
      }
      accessTokens = tokens;
      selectionCandidates = credentialEligible.filter((candidate) => tokens.has(candidate.id));
    }

    const selectionParams = {
      candidates: selectionCandidates,
      model: input.model,
      boundAccountId,
      boundTurnId,
      turnId: input.turn_id,
      excludeIds: input.exclude_ids,
      nowMs,
    };
    const availableCount = countSelectableCandidates(selectionParams);
    const chosen = selectBestCandidate(selectionParams);

    const previousActiveAccountId = this.sessionActivity.assignment(input.session_id);
    if (!chosen) {
      if (previousActiveAccountId) {
        this.sessionActivity.clearAssignment(input.session_id, previousActiveAccountId);
        this.maybeFinalizeDeferredRetire(previousActiveAccountId);
      }
      const enabledCandidates = candidates.filter((candidate) => candidate.enabled);
      const allEnabledNeedRelogin =
        enabledCandidates.length > 0 &&
        enabledCandidates.every((candidate) => candidate.auth_state === "needs_relogin");
      return {
        pool_exhausted: true,
        available_count: 0,
        earliest_available_at: computeEarliestAvailableAt(
          selectionCandidates,
          blocks,
          isFableModel(input.model) ? "fable" : "all",
          nowMs,
        ),
        ...(allEnabledNeedRelogin ? { reason: "needs_relogin" as const } : {}),
      };
    }

    const chosenCentral = centralById.get(chosen.id);
    if (chosenCentral) {
      this.store.ensureCentralProfileSymlinks(chosen.id);
    } else {
      this.store.ensureProfileSymlinks(chosen.id);
    }
    this.sessionActivity.assign(input.session_id, chosen.id, input.turn_id);
    if (previousActiveAccountId && previousActiveAccountId !== chosen.id) {
      this.maybeFinalizeDeferredRetire(previousActiveAccountId);
    }

    if (
      existingBinding?.account_id !== chosen.id ||
      existingBinding?.turn_id !== input.turn_id
    ) {
      bindings[input.session_id] = {
        account_id: chosen.id,
        turn_id: input.turn_id ?? null,
      };
      this.store.writeBindings(bindings);
    }

    const result: ClaudeAccountSelectionResult = {
      account_id: chosen.id,
      config_dir: chosenCentral
        ? this.store.centralProfileDir(chosen.id)
        : this.store.profileDir(chosen.id),
      // 로컬 계정의 결과 모양은 예전과 똑같이 둔다(중앙일 때만 표시).
      ...(chosenCentral ? { source: "central" as const } : {}),
      available_count: availableCount,
    };
    if (chosenCentral) {
      // 중앙 토큰은 매 턴 선택 응답으로 내려준다(전체 세션 포함).
      return {
        ...result,
        credential: {
          kind: "access-token",
          access_token: centralTokens.get(chosen.id)!,
        },
      };
    }
    if (!accessTokens) return result;
    // 선택 후보는 토큰 맵을 통과한 계정뿐이므로 고른 계정의 토큰은 항상 있다.
    return {
      ...result,
      credential: {
        kind: "access-token",
        access_token: accessTokens.get(chosen.id)!,
      },
    };
  }

  /** select의 후보와 바인딩. 측정을 기다린 뒤 다시 만들 수 있게 한곳에 모은다. */
  private buildSelectionPool(input: ClaudeAccountSelectionInput, nowMs: number) {
    const accounts = this.store.readAccounts();
    const bindings = this.store.readBindings();
    const blocks = this.store.readBlocks();
    const relogin = this.store.readRelogin();

    // 중앙 스냅샷에 같은 id가 있으면 그 로컬 계정은 가린다(파일은 지우지 않는다).
    const centralById = new Map(
      this.centralAccounts.map((account) => [account.id, account]),
    );
    const unmeasuredLocalIds = new Set<string>();
    const candidates: SelectableAccountCandidate[] = accounts
      .filter((acc) => !centralById.has(acc.id))
      .map((acc) => {
        const obs = this.usageCollector.getCachedObservation(
          acc.id,
          this.store.profileDir(acc.id),
        );
        if (isUnobservedObservation(obs)) unmeasuredLocalIds.add(acc.id);
        return {
          id: acc.id,
          enabled: acc.enabled && !this.pendingRetireAccountIds.has(acc.id),
          priority: acc.priority,
          auth_state: this.resolveEffectiveAuthState(acc.id, obs.auth_state, relogin),
          active_sessions: this.activeSessions(acc.id),
          stale: obs.stale,
          usage: obs.usage,
          blocks: blocks[acc.id],
          source: "local",
        };
      });

    // 중앙 후보: 켜져 있고, 인증 ok이며, 10분 넘게 살아 있는 토큰을 가진 계정만.
    // 이 노드에서 실패한 (계정, 토큰 지문)은 잠시 뺀다.
    const centralTokens = new Map<string, string>();
    for (const centralAccount of this.centralAccounts) {
      if (!isCentralAccountFresh(centralAccount, nowMs)) continue;
      if (this.isCentralExcluded(centralAccount, nowMs)) continue;
      if (this.isCredentialExcluded(centralAccount, input.exclude_credentials)) continue;
      centralTokens.set(centralAccount.id, centralAccount.access_token!);
      candidates.push({
        id: centralAccount.id,
        enabled: true,
        priority: centralAccount.priority,
        auth_state: "ok",
        active_sessions: this.activeSessions(centralAccount.id),
        stale: centralAccount.usage_raw === null,
        usage: centralAccountUsage(centralAccount),
        blocks: blocks[centralAccount.id],
        source: "central",
      });
    }

    const existingBinding = bindings[input.session_id];
    const boundAccountId =
      this.sessionActivity.assignment(input.session_id) ??
      existingBinding?.account_id ??
      null;
    const boundTurnId = existingBinding?.turn_id ?? null;

    return {
      bindings,
      blocks,
      centralById,
      centralTokens,
      candidates,
      unmeasuredLocalIds,
      existingBinding,
      boundAccountId,
      boundTurnId,
    };
  }

  async reject(input: ClaudeAccountRejectInput): Promise<void> {
    const blocks = this.store.readBlocks();
    const existing: ClaudeAccountBlocksRecord = blocks[input.account_id] ?? {};
    blocks[input.account_id] = {
      ...existing,
      [input.scope]: {
        resets_at: input.resets_at,
        observed_at: input.observed_at,
      },
    };
    this.store.writeBlocks(blocks);

    if (
      input.session_id &&
      this.sessionActivity.assignment(input.session_id) === input.account_id
    ) {
      this.sessionActivity.clearAssignment(input.session_id, input.account_id);
      this.maybeFinalizeDeferredRetire(input.account_id);
    }
  }

  async release(input: ClaudeAccountReleaseInput): Promise<void> {
    for (const accountId of this.sessionActivity.release(input)) {
      this.maybeFinalizeDeferredRetire(accountId);
    }
  }

  async restoreActiveBinding(input: {
    session_id: string;
    account_id: string;
  }): Promise<void> {
    const central = this.findCentralAccount(input.account_id);
    this.sessionActivity.restoreActiveBinding(
      input,
      this.store,
      central ? this.store.centralProfileDir(input.account_id) : null,
    );
  }

  async updateAccount(
    accountId: string,
    patch: ClaudeAccountUpdatePatch,
  ): Promise<ClaudeAccountView> {
    const accounts = this.store.readAccounts();
    const idx = accounts.findIndex((acc) => acc.id === accountId);
    if (idx === -1) {
      throw new ClaudeAccountNotFoundError(accountId);
    }

    const current = accounts[idx]!;
    const updated: ClaudeAccountRecord = {
      ...current,
      enabled:
        typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      priority:
        patch.priority !== undefined ? patch.priority : current.priority,
    };
    accounts[idx] = updated;
    this.store.writeAccounts(accounts);

    const list = await this.getAccountList();
    const view = list.accounts.find((acc) => acc.id === accountId);
    if (!view) {
      throw new ClaudeAccountNotFoundError(accountId);
    }
    return view;
  }

  async deleteAccount(accountId: string): Promise<ClaudeAccountDeleteResult> {
    const accounts = this.store.readAccounts();
    const idx = accounts.findIndex((acc) => acc.id === accountId);
    if (idx === -1) {
      throw new ClaudeAccountNotFoundError(accountId);
    }

    const activeCount = this.activeSessions(accountId);
    if (activeCount > 0) {
      accounts[idx] = {
        ...accounts[idx]!,
        enabled: false,
      };
      this.store.writeAccounts(accounts);
      this.pendingRetireAccountIds.add(accountId);
      this.removeBindingsForAccount(accountId);
      const list = await this.getAccountList();
      return {
        id: accountId,
        deleted: true,
        deferred: true,
        accounts: list.accounts,
        pool: list.pool,
        fable_pool: list.fable_pool,
      };
    }

    this.finalizeAccountRemoval(accountId, accounts);
    const list = await this.getAccountList();
    return {
      id: accountId,
      deleted: true,
      deferred: false,
      accounts: list.accounts,
      pool: list.pool,
      fable_pool: list.fable_pool,
    };
  }

  private removeBindingsForAccount(accountId: string): void {
    const bindings = this.store.readBindings();
    let changed = false;
    for (const [sessionId, boundEntry] of Object.entries(bindings)) {
      if (boundEntry.account_id === accountId) {
        delete bindings[sessionId];
        changed = true;
      }
    }
    if (changed) {
      this.store.writeBindings(bindings);
    }
  }

  private cleanupAccountReferences(accountId: string): void {
    this.removeBindingsForAccount(accountId);
    const blocks = this.store.readBlocks();
    if (accountId in blocks) {
      delete blocks[accountId];
      this.store.writeBlocks(blocks);
    }
    this.usageCollector.deleteCachedAccount(accountId);
    this.loggingInExpiresAt.delete(accountId);
    const relogin = this.store.readRelogin();
    if (accountId in relogin) {
      delete relogin[accountId];
      this.store.writeRelogin(relogin);
    }
  }

  private finalizeAccountRemoval(
    accountId: string,
    currentAccounts?: ClaudeAccountRecord[],
  ): void {
    const accounts = currentAccounts ?? this.store.readAccounts();
    const filtered = accounts.filter((acc) => acc.id !== accountId);
    this.store.writeAccounts(filtered);
    this.cleanupAccountReferences(accountId);
    this.pendingRetireAccountIds.delete(accountId);
    this.store.retireProfileDir(accountId);
  }

  private maybeFinalizeDeferredRetire(accountId: string): void {
    if (!this.pendingRetireAccountIds.has(accountId)) {
      return;
    }
    if (this.activeSessions(accountId) > 0) {
      return;
    }
    this.finalizeAccountRemoval(accountId);
  }

  async getAccountList(
    options: CollectAccountUsageOptions = {},
  ): Promise<ClaudeAccountList> {
    const nowMs = this.now();
    const accounts = this.store.readAccounts();
    const blocks = this.store.readBlocks();
    const centralIds = new Set(this.centralAccounts.map((account) => account.id));

    // 중앙 계정과 같은 id의 로컬 계정은 가린다. 조회와 갱신도 하지 않는다.
    const visibleLocalAccounts = accounts.filter((acc) => !centralIds.has(acc.id));

    // needs_relogin 계정도 계속 조회한다. 다음 사용량 조회가 성공해야 선택에 돌아온다.
    const pollTargets = visibleLocalAccounts
      .filter((acc) => !this.loggingInExpiresAt.has(acc.id))
      .map((acc) => ({
        accountId: acc.id,
        profileDir: this.store.profileDir(acc.id),
        renewExpiredCredentials: acc.enabled && !this.pendingRetireAccountIds.has(acc.id),
      }));

    const observations = await this.usageCollector.collectAll(
      pollTargets,
      options,
    );

    // 조회 중 콜백이 기록을 바꿨을 수 있으므로 조회 뒤에 읽는다.
    const relogin = this.store.readRelogin();
    const accountViews: ClaudeAccountView[] = visibleLocalAccounts.map((acc) => {
      const obs =
        observations.get(acc.id) ??
        this.usageCollector.getCachedObservation(
          acc.id,
          this.store.profileDir(acc.id),
        );
      const auth_state = this.resolveEffectiveAuthState(acc.id, obs.auth_state, relogin);
      return {
        id: acc.id,
        email: acc.email,
        plan: acc.plan,
        enabled: acc.enabled,
        priority: acc.priority,
        auth_state,
        login_expires_at: this.loggingInExpiresAt.get(acc.id) ?? null,
        active_sessions: this.activeSessions(acc.id),
        blocked: projectPublicBlockView(blocks[acc.id], nowMs),
        stale: obs.stale,
        observed_at: obs.observed_at,
        usage: obs.usage,
        source: "local",
      };
    });
    for (const centralAccount of this.centralAccounts) {
      accountViews.push(this.centralAccountView(centralAccount, blocks, nowMs));
    }

    const pool = computePoolSummary(accountViews, blocks, "all", nowMs);
    const fable_pool = computePoolSummary(accountViews, blocks, "fable", nowMs);

    return {
      mode: "pool",
      accounts: accountViews,
      pool,
      fable_pool,
    };
  }

  async getAccountListWithBestProjection(
    options: CollectAccountUsageOptions = {},
  ): Promise<{
    accountList: ClaudeAccountList;
    bestGeneralAccount: ClaudeAccountView | null;
    bestFableAccount: ClaudeAccountView | null;
  }> {
    const nowMs = this.now();
    const accountList = await this.getAccountList(options);
    const blocks = this.store.readBlocks();
    const bestGeneral = pickBestAccountForScope(
      accountList.accounts,
      blocks,
      "all",
      nowMs,
    );
    const bestFable = pickBestAccountForScope(
      accountList.accounts,
      blocks,
      "fable",
      nowMs,
    );
    return {
      accountList,
      bestGeneralAccount: bestGeneral?.account ?? null,
      bestFableAccount: bestFable?.account ?? null,
    };
  }
}
