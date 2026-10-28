import * as fs from "node:fs";
import { ClaudeAccountNotFoundError } from "./errors.js";
import {
  computeEarliestAvailableAt,
  computePoolSummary,
  pickBestAccountForScope,
} from "./pool.js";
import {
  countSelectableCandidates,
  isFableModel,
  projectPublicBlockView,
  selectBestCandidate,
  type SelectableAccountCandidate,
} from "./selector.js";
import { ClaudeAccountStore } from "./store.js";
import { ClaudeAccountSessionActivity } from "./session_activity.js";
import type {
  ClaudeAccountAuthState,
  ClaudeAccountBlocksRecord,
  ClaudeAccountDeleteResult,
  ClaudeAccountList,
  ClaudeAccountRecord,
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionResponse,
  ClaudeAccountUpdatePatch,
  ClaudeAccountView,
  ClaudeLoginAccountPort,
} from "./types.js";
import {
  ClaudeAccountUsageCollector,
  type CollectAccountUsageOptions,
} from "./usage.js";

export { ClaudeAccountNotFoundError } from "./errors.js";

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
  private readonly sessionActivity = new ClaudeAccountSessionActivity();
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

    this.loggingInAccountIds.delete(input.id);
    this.needsReloginAccountIds.delete(input.id);
    this.pendingRetireAccountIds.delete(input.id);
  }

  async beginRelogin(accountId: string): Promise<void> {
    this.loggingInAccountIds.add(accountId);
  }

  async endRelogin(
    accountId: string,
    outcome: "ok" | "needs_relogin",
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
  ): Promise<ClaudeAccountSelectionResponse> {
    const nowMs = this.now();
    const accounts = this.store.readAccounts();
    const bindings = this.store.readBindings();
    const blocks = this.store.readBlocks();

    const candidates: SelectableAccountCandidate[] = accounts.map((acc) => {
      const obs = this.usageCollector.getCachedObservation(
        acc.id,
        this.store.profileDir(acc.id),
      );
      return {
        id: acc.id,
        enabled: acc.enabled && !this.pendingRetireAccountIds.has(acc.id),
        priority: acc.priority,
        auth_state: this.resolveEffectiveAuthState(acc.id, obs.auth_state),
        active_sessions: this.activeSessions(acc.id),
        stale: obs.stale,
        usage: obs.usage,
        blocks: blocks[acc.id],
      };
    });

    const existingBinding = bindings[input.session_id];
    const boundAccountId =
      this.sessionActivity.assignment(input.session_id) ??
      existingBinding?.account_id ??
      null;
    const boundTurnId = existingBinding?.turn_id ?? null;

    const selectionParams = {
      candidates,
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
      return {
        pool_exhausted: true,
        available_count: 0,
        earliest_available_at: computeEarliestAvailableAt(
          candidates,
          blocks,
          isFableModel(input.model) ? "fable" : "all",
          nowMs,
        ),
      };
    }

    this.store.ensureProfileSymlinks(chosen.id);
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

    return {
      account_id: chosen.id,
      config_dir: this.store.profileDir(chosen.id),
      available_count: availableCount,
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
    this.sessionActivity.restoreActiveBinding(input, this.store);
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
        profileDir: this.store.profileDir(acc.id),
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
          this.store.profileDir(acc.id),
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
