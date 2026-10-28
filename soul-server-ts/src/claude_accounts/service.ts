import { computePoolSummary, pickBestAccountForScope } from "./pool.js";
import {
  projectPublicBlockView,
  selectBestCandidate,
  type SelectableAccountCandidate,
} from "./selector.js";
import { ClaudeAccountStore } from "./store.js";
import type {
  ClaudeAccountAuthState,
  ClaudeAccountBlocksRecord,
  ClaudeAccountDeleteResult,
  ClaudeAccountList,
  ClaudeAccountRecord,
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionResult,
  ClaudeAccountUpdatePatch,
  ClaudeAccountView,
  ClaudeLoginAccountPort,
} from "./types.js";
import {
  ClaudeAccountUsageCollector,
  type CollectAccountUsageOptions,
} from "./usage.js";

export class ClaudeAccountNotFoundError extends Error {
  readonly code = "ACCOUNT_NOT_FOUND";
  readonly accountId: string;

  constructor(accountId: string) {
    super(`Claude account not found: ${accountId}`);
    this.name = "ClaudeAccountNotFoundError";
    this.accountId = accountId;
  }
}

export interface ClaudeAccountServiceOptions {
  accountsDir: string;
  homeDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  pollTtlMs?: number;
  concurrency?: number;
  perAccountTimeoutMs?: number;
  usageEndpointUrl?: string;
}

export class ClaudeAccountService implements ClaudeLoginAccountPort {
  readonly store: ClaudeAccountStore;
  readonly usageCollector: ClaudeAccountUsageCollector;
  private readonly now: () => number;
  private readonly activeSessionAccounts = new Map<string, string>();
  private readonly loggingInAccountIds = new Set<string>();
  private readonly needsReloginAccountIds = new Set<string>();
  private readonly pendingRetireAccountIds = new Set<string>();

  constructor(options: ClaudeAccountServiceOptions) {
    this.now = options.now ?? (() => Date.now());
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
    });
  }

  activeSessions(accountId: string): number {
    let count = 0;
    for (const boundAccountId of this.activeSessionAccounts.values()) {
      if (boundAccountId === accountId) {
        count += 1;
      }
    }
    return count;
  }

  profileDir(accountId: string): string {
    return this.store.profileDir(accountId);
  }

  async createPendingDir(loginId: string): Promise<string> {
    return this.store.createPendingDir(loginId);
  }

  async retirePending(loginId: string): Promise<void> {
    this.store.retirePendingDir(loginId);
  }

  async findAccount(accountId: string): Promise<ClaudeAccountRecord | null> {
    const accounts = this.store.readAccounts();
    return accounts.find((acc) => acc.id === accountId) ?? null;
  }

  async findByIdentity(identity: {
    accountUuid: string;
    email?: string | null;
  }): Promise<ClaudeAccountRecord | null> {
    const accounts = this.store.readAccounts();
    const byId = accounts.find((acc) => acc.id === identity.accountUuid);
    if (byId) return byId;
    const normalizedEmail = identity.email?.trim().toLowerCase();
    if (!normalizedEmail) return null;
    return accounts.find((acc) => acc.email.trim().toLowerCase() === normalizedEmail) ?? null;
  }

  async registerFromPending(params: {
    loginId: string;
    accountUuid: string;
    email: string;
    plan: string;
    overwriteAccountId?: string;
  }): Promise<ClaudeAccountRecord> {
    this.store.promotePendingToProfile({
      loginId: params.loginId,
      accountUuid: params.accountUuid,
    });

    const nowIso = new Date(this.now()).toISOString();
    const accounts = this.store.readAccounts();
    const existingByUuid = accounts.find((acc) => acc.id === params.accountUuid);
    const existingByOverwrite =
      params.overwriteAccountId && params.overwriteAccountId !== params.accountUuid
        ? accounts.find((acc) => acc.id === params.overwriteAccountId)
        : undefined;

    const baseRecord = existingByUuid ?? existingByOverwrite;
    const record: ClaudeAccountRecord = {
      id: params.accountUuid,
      email: params.email,
      plan: params.plan,
      enabled: baseRecord ? baseRecord.enabled : true,
      priority: baseRecord ? baseRecord.priority : null,
      created_at: baseRecord ? baseRecord.created_at : nowIso,
    };

    const nextAccounts = accounts.filter(
      (acc) =>
        acc.id !== params.accountUuid &&
        (!params.overwriteAccountId || acc.id !== params.overwriteAccountId),
    );
    nextAccounts.push(record);
    this.store.writeAccounts(nextAccounts);

    if (params.overwriteAccountId && params.overwriteAccountId !== params.accountUuid) {
      this.cleanupAccountReferences(params.overwriteAccountId);
      if (this.activeSessions(params.overwriteAccountId) === 0) {
        this.store.retireProfileDir(params.overwriteAccountId);
      } else {
        this.pendingRetireAccountIds.add(params.overwriteAccountId);
      }
    }

    this.loggingInAccountIds.delete(params.accountUuid);
    this.needsReloginAccountIds.delete(params.accountUuid);
    this.pendingRetireAccountIds.delete(params.accountUuid);
    return record;
  }

  async beginRelogin(accountId: string): Promise<void> {
    this.loggingInAccountIds.add(accountId);
  }

  async endRelogin(
    accountId: string,
    outcome: "ok" | "needs_relogin" | "cancelled",
  ): Promise<void> {
    this.loggingInAccountIds.delete(accountId);
    if (outcome === "ok") {
      this.needsReloginAccountIds.delete(accountId);
      this.store.ensureProfileSymlinks(accountId);
    } else if (outcome === "needs_relogin") {
      this.needsReloginAccountIds.add(accountId);
    }
  }

  async markNeedsRelogin(accountId: string): Promise<void> {
    this.loggingInAccountIds.delete(accountId);
    this.needsReloginAccountIds.add(accountId);
  }

  private resolveEffectiveAuthState(
    accountId: string,
    observedState: "ok" | "idle",
  ): ClaudeAccountAuthState {
    if (this.loggingInAccountIds.has(accountId)) return "logging_in";
    if (this.needsReloginAccountIds.has(accountId)) return "needs_relogin";
    return observedState;
  }

  async select(
    input: ClaudeAccountSelectionInput,
  ): Promise<ClaudeAccountSelectionResult | null> {
    const nowMs = this.now();
    const accounts = this.store.readAccounts();
    const bindings = this.store.readBindings();
    const blocks = this.store.readBlocks();

    const candidates: SelectableAccountCandidate[] = accounts.map((acc) => {
      const obs = this.usageCollector.getCachedObservation(acc.id, this.profileDir(acc.id));
      return {
        id: acc.id,
        enabled: acc.enabled && !this.pendingRetireAccountIds.has(acc.id),
        priority: acc.priority,
        auth_state: this.resolveEffectiveAuthState(acc.id, obs.auth_state),
        active_sessions: this.activeSessions(acc.id),
        usage: obs.usage,
        blocks: blocks[acc.id],
      };
    });

    const boundAccountId =
      this.activeSessionAccounts.get(input.session_id) ?? bindings[input.session_id] ?? null;

    const chosen = selectBestCandidate({
      candidates,
      model: input.model,
      boundAccountId,
      excludeIds: input.exclude_ids,
      nowMs,
    });

    const previousActiveAccountId = this.activeSessionAccounts.get(input.session_id);
    if (!chosen) {
      if (previousActiveAccountId) {
        this.activeSessionAccounts.delete(input.session_id);
        this.maybeFinalizeDeferredRetire(previousActiveAccountId);
      }
      return null;
    }

    this.store.ensureProfileSymlinks(chosen.id);
    this.activeSessionAccounts.set(input.session_id, chosen.id);
    if (previousActiveAccountId && previousActiveAccountId !== chosen.id) {
      this.maybeFinalizeDeferredRetire(previousActiveAccountId);
    }

    if (bindings[input.session_id] !== chosen.id) {
      bindings[input.session_id] = chosen.id;
      this.store.writeBindings(bindings);
    } else if (this.activeSessionAccounts.size === 1) {
      this.store.writeBindings(bindings);
    }

    return { account_id: chosen.id, config_dir: this.profileDir(chosen.id) };
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
      this.activeSessionAccounts.get(input.session_id) === input.account_id
    ) {
      this.activeSessionAccounts.delete(input.session_id);
      this.maybeFinalizeDeferredRetire(input.account_id);
    }
  }

  async release(input: ClaudeAccountReleaseInput): Promise<void> {
    const previousAccountId = this.activeSessionAccounts.get(input.session_id);
    if (!previousAccountId) {
      return;
    }
    this.activeSessionAccounts.delete(input.session_id);
    this.maybeFinalizeDeferredRetire(previousAccountId);
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
    for (const [sessionId, boundId] of Object.entries(bindings)) {
      if (boundId === accountId) {
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
    this.loggingInAccountIds.delete(accountId);
    this.needsReloginAccountIds.delete(accountId);
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

    const pollTargets = accounts
      .filter(
        (acc) =>
          !this.loggingInAccountIds.has(acc.id) &&
          !this.needsReloginAccountIds.has(acc.id),
      )
      .map((acc) => ({
        accountId: acc.id,
        profileDir: this.profileDir(acc.id),
      }));

    const observations = await this.usageCollector.collectAll(
      pollTargets,
      options,
    );

    const accountViews: ClaudeAccountView[] = accounts.map((acc) => {
      const obs =
        observations.get(acc.id) ??
        this.usageCollector.getCachedObservation(
          acc.id,
          this.profileDir(acc.id),
        );
      const auth_state = this.resolveEffectiveAuthState(acc.id, obs.auth_state);
      return {
        id: acc.id,
        email: acc.email,
        plan: acc.plan,
        enabled: acc.enabled,
        priority: acc.priority,
        auth_state,
        active_sessions: this.activeSessions(acc.id),
        blocked: projectPublicBlockView(blocks[acc.id], nowMs),
        stale: obs.stale,
        observed_at: obs.observed_at,
        usage: obs.usage,
      };
    });

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
