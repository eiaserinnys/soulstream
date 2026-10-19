import type {
  CanonicalUsageSelection,
  FactDraft,
  NormalizedUsage,
  UsageCandidateType,
} from "./session_statistics_fact_types.js";
import { compareText, isRecord } from "./session_statistics_normalization_helpers.js";
import { priceNormalizedUsage } from "./session_statistics_usage_candidates.js";

export const CANONICAL_USAGE_PRIORITY = {
  complete: 4,
  failed_error: 3,
  failed_result: 2,
  interrupt_observation: 1,
} as const;

type UsageEventGroup = {
  sessionId: string;
  eventId: number | string;
  accountingKey: string | null;
  inputId: string | null;
  candidateType: UsageCandidateType | null;
  facts: FactDraft[];
};

function compareEventIds(left: number | string, right: number | string): number {
  const leftText = String(left);
  const rightText = String(right);
  if (/^\d+$/.test(leftText) && /^\d+$/.test(rightText)) {
    const leftBig = BigInt(leftText);
    const rightBig = BigInt(rightText);
    return leftBig < rightBig ? -1 : leftBig > rightBig ? 1 : 0;
  }
  return compareText(leftText, rightText);
}

function usageEventGroups(facts: readonly FactDraft[]): UsageEventGroup[] {
  const groups = new Map<string, UsageEventGroup>();
  for (const fact of facts) {
    if (fact.fact_kind !== "usage") continue;
    const key = `${fact.session_id}\u0000${String(fact.event_id)}`;
    const existing = groups.get(key);
    if (existing) existing.facts.push(fact);
    else groups.set(key, {
      sessionId: fact.session_id,
      eventId: fact.event_id,
      accountingKey: fact.accounting_key,
      inputId: fact.input_id,
      candidateType: fact.candidate_type,
      facts: [fact],
    });
  }
  return [...groups.values()];
}

function sameKnownComponent(rows: readonly FactDraft[], field: keyof NormalizedUsage): boolean {
  const aggregate = rows.find((row) => row.representation === "aggregate");
  const models = rows.filter((row) => row.representation === "model_breakdown");
  if (!aggregate || models.length === 0) return false;
  const aggregateValue = aggregate[field];
  const modelValues = models.map((row) => row[field]);
  if (aggregateValue === null) return modelValues.every((value) => value === null);
  return modelValues.every((value) => value !== null)
    && modelValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) === aggregateValue;
}

function validModelBreakdown(rows: readonly FactDraft[]): boolean {
  const aggregate = rows.find((row) => row.representation === "aggregate");
  const models = rows.filter((row) => row.representation === "model_breakdown");
  if (!aggregate || models.length === 0 || aggregate.input_total === null || aggregate.output_total === null) return false;
  return sameKnownComponent(rows, "input_total")
    && sameKnownComponent(rows, "output_total")
    && sameKnownComponent(rows, "cache_read")
    && sameKnownComponent(rows, "cache_write")
    && sameKnownComponent(rows, "reasoning_output");
}

function selectedRepresentation(group: UsageEventGroup): {
  facts: FactDraft[];
  representation: FactDraft["representation"];
  quality: string[];
} {
  const aggregate = group.facts.filter((fact) => fact.representation === "aggregate");
  const models = group.facts.filter((fact) => fact.representation === "model_breakdown");
  if (validModelBreakdown(group.facts)) {
    return { facts: models, representation: "model_breakdown", quality: [] };
  }
  if (aggregate.length > 0) {
    const aggregateFact = aggregate[0]!;
    const breakdownUnverified = models.length > 0
      || aggregateFact.quality.includes("model_breakdown_unverified")
      || isRecord(aggregateFact.raw_numeric?.model_usage);
    const selectedFact = breakdownUnverified ? {
      ...aggregateFact,
      model: null,
      ...priceNormalizedUsage({
        input_total: aggregateFact.input_total,
        output_total: aggregateFact.output_total,
        total_tokens: aggregateFact.total_tokens,
        cache_read: aggregateFact.cache_read,
        cache_write: aggregateFact.cache_write,
        reasoning_output: aggregateFact.reasoning_output,
      }, aggregateFact.provider, null),
      quality: [...new Set([...aggregateFact.quality, "model_breakdown_unverified"])].sort(compareText),
    } : aggregateFact;
    return {
      facts: [selectedFact],
      representation: "aggregate",
      quality: breakdownUnverified ? ["model_breakdown_unverified"] : [],
    };
  }
  return {
    facts: [],
    representation: "diagnostic",
    quality: models.length > 0 ? ["model_breakdown_unverified"] : [],
  };
}

function makeSelection(
  group: UsageEventGroup,
  state: CanonicalUsageSelection["state"],
  ownerEventId: number | string | null,
  candidateEventId: number | string | null,
  facts: FactDraft[],
  representation: FactDraft["representation"],
  quality: readonly string[] = [],
): CanonicalUsageSelection {
  return {
    sessionId: group.sessionId,
    accountingKey: group.accountingKey,
    ownerEventId,
    candidateEventId,
    candidateType: group.candidateType,
    representation,
    state,
    facts,
    quality: [...new Set(quality)].sort(compareText),
  };
}

function isIdentityConflict(group: UsageEventGroup): boolean {
  return group.facts.some((fact) => fact.quality.includes("identity_conflict"));
}

function isTerminalCandidate(group: UsageEventGroup): boolean {
  return group.candidateType !== null
    && Object.prototype.hasOwnProperty.call(CANONICAL_USAGE_PRIORITY, group.candidateType);
}

function inputIsClosed(
  group: UsageEventGroup,
  boundaries: readonly FactDraft[],
): boolean {
  const inputs = boundaries.filter((fact) => fact.session_id === group.sessionId && fact.boundary_type === "input");
  const exact = group.inputId === null ? undefined : inputs.find((fact) => fact.input_id === group.inputId);
  const previous = exact ?? inputs
    .filter((fact) => compareEventIds(fact.event_id, group.eventId) <= 0)
    .sort((left, right) => compareEventIds(right.event_id, left.event_id))[0];
  if (!previous) return false;
  return boundaries.some((fact) => fact.session_id === group.sessionId
    && (fact.boundary_type === "input" || fact.boundary_type === "session_ended")
    && compareEventIds(fact.event_id, previous.event_id) > 0);
}

function selectionSort(left: CanonicalUsageSelection, right: CanonicalUsageSelection): number {
  return compareText(left.sessionId, right.sessionId)
    || compareText(left.accountingKey ?? "", right.accountingKey ?? "")
    || compareEventIds(left.candidateEventId ?? left.ownerEventId ?? "0", right.candidateEventId ?? right.ownerEventId ?? "0");
}

export function selectCanonicalUsageCandidates(
  candidates: readonly FactDraft[],
): CanonicalUsageSelection[] {
  const groups = usageEventGroups(candidates);
  const boundaries = candidates.filter((fact) => fact.fact_kind === "boundary");
  const keyed = new Map<string, UsageEventGroup[]>();
  const legacy: UsageEventGroup[] = [];
  const selections: CanonicalUsageSelection[] = [];

  for (const group of groups) {
    if (isIdentityConflict(group)) {
      selections.push(makeSelection(group, "identity_conflict", null, group.eventId, [], "diagnostic", ["identity_conflict"]));
    } else if (group.accountingKey === null) {
      legacy.push(group);
    } else {
      const key = `${group.sessionId}\u0000${group.accountingKey}`;
      const entries = keyed.get(key) ?? [];
      entries.push(group);
      keyed.set(key, entries);
    }
  }

  for (const groupsForKey of keyed.values()) {
    const terminals = groupsForKey.filter(isTerminalCandidate).sort((left, right) => {
      const priority = CANONICAL_USAGE_PRIORITY[right.candidateType as keyof typeof CANONICAL_USAGE_PRIORITY]
        - CANONICAL_USAGE_PRIORITY[left.candidateType as keyof typeof CANONICAL_USAGE_PRIORITY];
      return priority || compareEventIds(right.eventId, left.eventId);
    });
    if (terminals.length > 0) {
      const owner = terminals[0]!;
      const chosen = selectedRepresentation(owner);
      selections.push(makeSelection(owner, "owned", owner.eventId, owner.eventId, chosen.facts, chosen.representation, chosen.quality));
      continue;
    }
    const successes = groupsForKey.filter((group) => group.candidateType === "success_result")
      .sort((left, right) => compareEventIds(right.eventId, left.eventId));
    if (successes.length > 0) {
      const pending = successes[0]!;
      selections.push(makeSelection(
        pending,
        inputIsClosed(pending, boundaries) ? "missing" : "pending",
        null,
        pending.eventId,
        [],
        "diagnostic",
      ));
    }
  }

  const validLegacy = legacy.filter((group) => group.candidateType !== null);
  for (const group of validLegacy) {
    if (group.candidateType !== "complete") continue;
    const chosen = selectedRepresentation(group);
    selections.push(makeSelection(group, "owned", group.eventId, group.eventId, chosen.facts, chosen.representation, chosen.quality));
  }

  const failedLegacy = validLegacy.filter((group) =>
    group.candidateType === "failed_result" || group.candidateType === "failed_error");
  const inputBoundaries = boundaries.filter((fact) => fact.boundary_type === "input");
  const groupedFailures = new Map<string, { start: FactDraft; end: FactDraft | null; groups: UsageEventGroup[] }>();
  for (const group of failedLegacy) {
    const prior = inputBoundaries
      .filter((fact) => fact.session_id === group.sessionId && compareEventIds(fact.event_id, group.eventId) <= 0)
      .sort((left, right) => compareEventIds(right.event_id, left.event_id))[0];
    if (!prior) {
      selections.push(makeSelection(group, "unresolved_legacy", null, group.eventId, [], "diagnostic", ["unresolved_legacy_accounting"]));
      continue;
    }
    const next = inputBoundaries
      .filter((fact) => fact.session_id === group.sessionId && compareEventIds(fact.event_id, prior.event_id) > 0)
      .sort((left, right) => compareEventIds(left.event_id, right.event_id))[0] ?? null;
    const key = `${group.sessionId}\u0000${String(prior.event_id)}`;
    const current = groupedFailures.get(key) ?? { start: prior, end: next, groups: [] };
    current.groups.push(group);
    groupedFailures.set(key, current);
  }

  for (const { start, end, groups: failures } of groupedFailures.values()) {
    const sessionId = failures[0]!.sessionId;
    const hasOtherOwner = groups.some((group) => group.sessionId === sessionId
      && group.accountingKey !== null
      && !isIdentityConflict(group)
      && isTerminalCandidate(group)
      && compareEventIds(group.eventId, start.event_id) >= 0
      && (end === null || compareEventIds(group.eventId, end.event_id) < 0))
      || legacy.some((group) => group.sessionId === sessionId
        && group.candidateType === "complete"
        && compareEventIds(group.eventId, start.event_id) >= 0
        && (end === null || compareEventIds(group.eventId, end.event_id) < 0));
    if (failures.length === 1 && !hasOtherOwner) {
      const failure = failures[0]!;
      const chosen = selectedRepresentation(failure);
      selections.push(makeSelection(failure, "owned", failure.eventId, failure.eventId, chosen.facts, chosen.representation, chosen.quality));
    } else {
      const candidateTypes = new Set(failures.map((group) => group.candidateType));
      const first = failures[0]!;
      selections.push({
        sessionId,
        accountingKey: null,
        ownerEventId: null,
        candidateEventId: null,
        candidateType: candidateTypes.size === 1 ? first.candidateType : null,
        representation: "diagnostic",
        state: "ambiguous_legacy",
        facts: failures.flatMap((group) => group.facts),
        quality: ["ambiguous_legacy_accounting"],
      });
    }
  }

  return selections.sort(selectionSort);
}

export function selectCanonicalInputMaterialFacts(
  candidates: readonly FactDraft[],
): FactDraft[] {
  const materialFacts = candidates.filter((fact) => fact.fact_kind === "input_material");
  const boundaries = candidates.filter((fact) => fact.fact_kind === "boundary");
  const latestNewManifest = new Map<string, FactDraft>();
  const validNewManifests = boundaries.filter((fact) =>
    fact.source_event_type === "input_material_manifest"
    && fact.accounting_key !== null
    && !fact.quality.includes("identity_conflict"));
  for (const boundary of validNewManifests) {
    const key = `${boundary.session_id}\u0000${boundary.accounting_key}`;
    const previous = latestNewManifest.get(key);
    if (!previous || compareEventIds(boundary.event_id, previous.event_id) > 0) latestNewManifest.set(key, boundary);
  }
  const selectedNewManifestEvents = new Set([...latestNewManifest.values()]
    .map((fact) => `${fact.session_id}\u0000${String(fact.event_id)}`));
  const newManifestInputIds = new Set([...latestNewManifest.values()]
    .filter((fact) => fact.input_id !== null)
    .map((fact) => `${fact.session_id}\u0000${fact.input_id}`));

  const bodyInputIds = new Set(materialFacts
    .filter((fact) => fact.source_event_type === "user_message" || fact.source_event_type === "system_message")
    .filter((fact) => fact.input_id !== null)
    .map((fact) => `${fact.session_id}\u0000${fact.input_id}`));
  const latestLegacyManifest = new Map<string, FactDraft>();
  for (const fact of materialFacts.filter((item) => item.source_event_type === "context_manifest")) {
    if (fact.input_id === null || !bodyInputIds.has(`${fact.session_id}\u0000${fact.input_id}`)) continue;
    if (newManifestInputIds.has(`${fact.session_id}\u0000${fact.input_id}`)) continue;
    const key = `${fact.session_id}\u0000${fact.input_id}`;
    const previous = latestLegacyManifest.get(key);
    if (!previous || compareEventIds(fact.event_id, previous.event_id) > 0) latestLegacyManifest.set(key, fact);
  }
  const selectedLegacyManifestEvents = new Set([...latestLegacyManifest.values()]
    .map((fact) => `${fact.session_id}\u0000${String(fact.event_id)}`));
  const legacyManifestInputIds = new Set([...latestLegacyManifest.values()]
    .filter((fact) => fact.input_id !== null)
    .map((fact) => `${fact.session_id}\u0000${fact.input_id}`));

  return materialFacts.filter((fact) => {
    if (fact.quality.includes("identity_conflict")) return false;
    if (fact.quality.includes("unmatched_legacy_material")) return false;
    if (fact.source_event_type === "input_material_manifest") {
      return selectedNewManifestEvents.has(`${fact.session_id}\u0000${String(fact.event_id)}`);
    }
    if (fact.source_event_type === "context_manifest") {
      return selectedLegacyManifestEvents.has(`${fact.session_id}\u0000${String(fact.event_id)}`)
        && !fact.quality.includes("unmatched_legacy_material");
    }
    if (fact.source_event_type === "user_message" || fact.source_event_type === "system_message") {
      if (fact.input_id === null) return true;
      const key = `${fact.session_id}\u0000${fact.input_id}`;
      return !newManifestInputIds.has(key) && !legacyManifestInputIds.has(key);
    }
    return fact.source_event_type === "tool_result";
  }).sort((left, right) =>
    compareText(left.session_id, right.session_id)
    || compareEventIds(left.event_id, right.event_id)
    || compareText(left.part_key, right.part_key));
}
