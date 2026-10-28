import * as fs from "node:fs";

import { ClaudeAccountNotFoundError } from "./errors.js";
import type { ClaudeAccountStore } from "./store.js";
import type { ClaudeAccountReleaseInput } from "./types.js";

export class ClaudeAccountSessionActivity {
  private readonly assignments = new Map<string, { accountId: string; turnId: string | null }>();
  private readonly activeQueries = new Map<string, Set<string>>();

  activeSessions(accountId: string): number {
    let count = 0;
    for (const [sessionId, assignment] of this.assignments) {
      if (assignment.accountId === accountId && !this.activeQueries.get(sessionId)?.has(accountId)) {
        count += 1;
      }
    }
    for (const accounts of this.activeQueries.values()) {
      if (accounts.has(accountId)) count += 1;
    }
    return count;
  }

  assignment(sessionId: string): string | undefined {
    return this.assignments.get(sessionId)?.accountId;
  }

  assign(sessionId: string, accountId: string, turnId: string | null): void {
    this.assignments.set(sessionId, { accountId, turnId });
  }

  clearAssignment(sessionId: string, expectedAccountId?: string): string | undefined {
    const current = this.assignments.get(sessionId);
    if (!current || (expectedAccountId && current.accountId !== expectedAccountId)) return undefined;
    this.assignments.delete(sessionId);
    return current.accountId;
  }

  release(input: ClaudeAccountReleaseInput): string[] {
    const sessionId = input.session_id;
    const affected = new Set<string>();
    const currentAssignment = this.assignments.get(sessionId);
    const preserveAssignment = Boolean(input.turn_id && currentAssignment?.turnId
      && input.turn_id !== currentAssignment.turnId);
    const queryAccounts = this.activeQueries.get(sessionId);

    if (input.clear_all) {
      if (currentAssignment) affected.add(currentAssignment.accountId);
      for (const accountId of queryAccounts ?? []) affected.add(accountId);
      this.assignments.delete(sessionId);
      this.activeQueries.delete(sessionId);
    } else if (input.account_id) {
      const accountId = input.account_id;
      if (input.keep_query_active) {
        if (currentAssignment?.accountId === accountId && !preserveAssignment) this.assignments.delete(sessionId);
        const retained = queryAccounts ?? new Set<string>();
        retained.add(accountId);
        this.activeQueries.set(sessionId, retained);
      } else {
        queryAccounts?.delete(accountId);
        if (queryAccounts?.size === 0) this.activeQueries.delete(sessionId);
        if (currentAssignment?.accountId === accountId && !preserveAssignment) this.assignments.delete(sessionId);
        affected.add(accountId);
      }
    } else if (currentAssignment && !preserveAssignment) {
      this.assignments.delete(sessionId);
      affected.add(currentAssignment.accountId);
    }
    return [...affected];
  }

  restoreActiveBinding(
    input: { session_id: string; account_id: string },
    store: Pick<ClaudeAccountStore, "readBindings" | "readAccounts" | "profileDir">,
  ): void {
    const binding = store.readBindings()[input.session_id];
    if (binding?.account_id !== input.account_id) {
      throw new Error(`Claude account runner binding mismatch for session ${input.session_id}`);
    }
    if (!store.readAccounts().some((account) => account.id === input.account_id)) {
      throw new ClaudeAccountNotFoundError(input.account_id);
    }
    if (!fs.existsSync(store.profileDir(input.account_id))) {
      throw new Error(`Claude account profile is missing: ${input.account_id}`);
    }
    const existingAccountId = this.assignment(input.session_id);
    if (existingAccountId && existingAccountId !== input.account_id) {
      throw new Error(`Claude account session is already active on ${existingAccountId}`);
    }
    this.assign(input.session_id, input.account_id, binding.turn_id);
    const queryAccounts = this.activeQueries.get(input.session_id) ?? new Set<string>();
    queryAccounts.add(input.account_id);
    this.activeQueries.set(input.session_id, queryAccounts);
  }
}
