import type { UsageSummaryClaudeAccount } from "./provider_usage_wire.js";

export function mergeClaudePoolObservations(
  localAccounts: readonly UsageSummaryClaudeAccount[],
  peerAccountLists: readonly (readonly UsageSummaryClaudeAccount[])[],
): readonly UsageSummaryClaudeAccount[] {
  const localIds = new Set(localAccounts.map((account) => account.id));
  const freshest = new Map<string, { account: UsageSummaryClaudeAccount; observedAt: number }>();
  for (const account of localAccounts) {
    const observedAt = observationTime(account);
    if (observedAt !== null) freshest.set(account.id, { account, observedAt });
  }

  for (const peerAccounts of peerAccountLists) {
    for (const account of peerAccounts) {
      if (!localIds.has(account.id)) continue;
      const observedAt = observationTime(account);
      const current = freshest.get(account.id);
      if (observedAt !== null && (current === undefined || observedAt > current.observedAt)) {
        freshest.set(account.id, { account, observedAt });
      }
    }
  }

  return localAccounts.map((account) => {
    const observation = freshest.get(account.id)?.account;
    if (observation === undefined || observation === account) return account;
    return {
      ...account,
      usage: observation.usage,
      observed_at: observation.observed_at,
      blocked: observation.blocked,
    };
  });
}

function observationTime(account: UsageSummaryClaudeAccount): number | null {
  if (account.observed_at === null) return null;
  const observedAt = Date.parse(account.observed_at);
  return Number.isFinite(observedAt) ? observedAt : null;
}
