import type { UsageSummaryClaudeAccount } from "./provider_usage_wire.js";

export type ClaudePoolPeerBlock = NonNullable<UsageSummaryClaudeAccount["blocked"]>;

export type ClaudePoolAvailabilityAccount = UsageSummaryClaudeAccount & {
  readonly peer_blocks?: readonly ClaudePoolPeerBlock[];
};

export function mergeClaudePoolObservations(
  localAccounts: readonly UsageSummaryClaudeAccount[],
  peerAccountLists: readonly (readonly UsageSummaryClaudeAccount[])[],
): readonly ClaudePoolAvailabilityAccount[] {
  const localIds = new Set(localAccounts.map((account) => account.id));
  const freshest = new Map<string, { account: UsageSummaryClaudeAccount; observedAt: number }>();
  const blocked = new Map<string, UsageSummaryClaudeAccount["blocked"]>();
  const peerBlocks = new Map<string, ClaudePoolPeerBlock[]>();
  for (const account of localAccounts) {
    blocked.set(account.id, account.blocked);
    const observedAt = observationTime(account);
    if (observedAt !== null) freshest.set(account.id, { account, observedAt });
  }

  for (const peerAccounts of peerAccountLists) {
    for (const account of peerAccounts) {
      if (!localIds.has(account.id)) continue;
      blocked.set(account.id, mergeBlocked(blocked.get(account.id) ?? null, account.blocked));
      if (account.blocked !== null) {
        peerBlocks.set(account.id, mergeBlocksByScope(
          peerBlocks.get(account.id) ?? [],
          account.blocked,
        ));
      }
      const observedAt = observationTime(account);
      const current = freshest.get(account.id);
      if (observedAt !== null && (current === undefined || observedAt > current.observedAt)) {
        freshest.set(account.id, { account, observedAt });
      }
    }
  }

  return localAccounts.map((account) => {
    const observation = freshest.get(account.id)?.account;
    const mergedBlocked = blocked.get(account.id) ?? null;
    const sharedBlocks = peerBlocks.get(account.id);
    if (
      (observation === undefined || observation === account)
      && mergedBlocked === account.blocked
      && sharedBlocks === undefined
    ) return account;
    return {
      ...account,
      ...(observation === undefined ? {} : {
        usage: observation.usage,
        observed_at: observation.observed_at,
      }),
      blocked: mergedBlocked,
      ...(sharedBlocks === undefined ? {} : { peer_blocks: sharedBlocks }),
    };
  });
}

function mergeBlocked(
  current: UsageSummaryClaudeAccount["blocked"],
  candidate: UsageSummaryClaudeAccount["blocked"],
): UsageSummaryClaudeAccount["blocked"] {
  if (current === null) return candidate;
  if (candidate === null) return current;
  return latestBlock(current, candidate);
}

function mergeBlocksByScope(
  current: readonly ClaudePoolPeerBlock[],
  candidate: ClaudePoolPeerBlock,
): ClaudePoolPeerBlock[] {
  const existing = current.find((block) => block.scope === candidate.scope);
  if (existing === undefined) return [...current, candidate];
  return current.map((block) => block.scope === candidate.scope
    ? latestBlock(block, candidate)
    : block);
}

function latestBlock(
  current: ClaudePoolPeerBlock,
  candidate: ClaudePoolPeerBlock,
): ClaudePoolPeerBlock {
  if (current.until === null || candidate.until === null) {
    if (current.until === null && candidate.until !== null) return current;
    if (candidate.until === null && current.until !== null) return candidate;
    return current.scope === "all" ? current : candidate.scope === "all" ? candidate : current;
  }
  const currentReset = Date.parse(current.until);
  const candidateReset = Date.parse(candidate.until);
  if (!Number.isFinite(candidateReset)) return current;
  if (!Number.isFinite(currentReset) || candidateReset > currentReset) return candidate;
  return current;
}

function observationTime(account: UsageSummaryClaudeAccount): number | null {
  if (account.observed_at === null) return null;
  const observedAt = Date.parse(account.observed_at);
  return Number.isFinite(observedAt) ? observedAt : null;
}
