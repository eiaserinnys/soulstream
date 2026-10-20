import type {
  UsageStatsCoverage,
  UsageStatsProvider,
} from "@soulstream/wire-schema/session-statistics";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";
import { sessionStatisticsInPeriod } from "./session_statistics_scope.js";
import {
  sessionStatisticsDateMatches,
  sessionStatisticsEventOrder,
  sessionStatisticsProjectIdForSession,
  sessionStatisticsProjectMatches,
  sessionStatisticsRowProjectMatches,
  sessionStatisticsSourceKey,
} from "./session_statistics_aggregate.js";
import type { SessionStatisticsScope } from "./session_statistics_aggregate.js";
import { foldTokenPartials } from "./session_statistics_field_coverage.js";
import { sourceTokenMetrics, type SourceTokenInput } from "./session_statistics_token_metrics.js";

// 500줄 상한을 넘는다: 경계·커버리지 색인 로직은 이 파일의 응집 단위이며,
// 집계 TS 선형화 범위 밖으로 분리하지 않는다.

type Row = SessionStatisticsReadResult["rows"][number];
type Fact = NonNullable<Row["fact"]>;

type Attribution = { provider: UsageStatsProvider; model: string | null };
type EvidenceKind = "terminal" | "ended" | "pending";

type Evidence = {
  row: Row;
  identityKey: string;
  sessionId: string;
  projectId: string | null;
  kind: EvidenceKind;
  timestamp: string | null;
  eventOrder: number;
  attribution: Attribution | null;
  unknownAllUsageFields: boolean;
};

type Owner = {
  ownerKey: string;
  sessionId: string;
  projectId: string | null;
  identityKey: string;
  timestamp: string | null;
  eventOrder: number;
  parts: Array<{ row: Row; fact: Fact; sourceKey: string }>;
  factlessRows: Row[];
};

export type SessionStatisticsCoverageIndex = {
  owners: readonly Owner[];
  missing: readonly Evidence[];
  pending: readonly Evidence[];
  allMissingIdentityKeys: ReadonlySet<string>;
};

const PROVIDERS = new Set<UsageStatsProvider>([
  "claude", "codex", "antigravity", "deepseek", "kimi", "unknown",
]);

function identityKey(sessionId: string, identity: string): string {
  return JSON.stringify([sessionId, identity]);
}

function rowTimestamp(row: Row): string | null {
  return row.owner_recorded_at ?? row.fact?.recorded_at ?? null;
}

function inputIdentity(inputId: string | null, eventId: number | string): string {
  return inputId === null ? `user_event:${String(eventId)}` : `input:${inputId}`;
}

function boundaryRows(read: SessionStatisticsReadResult): Row[] {
  return read.rows.filter((row) => row.row_kind === "boundary"
    && row.state === "owned"
    && row.fact?.fact_kind === "boundary");
}

function groupBySessionOrdered(rows: readonly Row[]): ReadonlyMap<string, readonly Row[]> {
  const bySession = new Map<string, Row[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id);
    if (list !== undefined) list.push(row);
    else bySession.set(row.session_id, [row]);
  }
  for (const list of bySession.values()) {
    list.sort((left, right) => sessionStatisticsEventOrder(left) - sessionStatisticsEventOrder(right));
  }
  return bySession;
}

function firstOrderAbove(rows: readonly Row[], order: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sessionStatisticsEventOrder(rows[middle]!) <= order) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstBoundaryAfter(rows: readonly Row[] | undefined, startOrder: number): Row | undefined {
  if (rows === undefined) return undefined;
  for (let index = firstOrderAbove(rows, startOrder); index < rows.length; index += 1) {
    const fact = rows[index]!.fact;
    if (fact?.fact_kind === "boundary"
      && (fact.boundary_type === "input" || fact.boundary_type === "session_ended")) return rows[index];
  }
  return undefined;
}

function getInputStarts(rows: readonly Row[]): Map<string, Row> {
  const starts = new Map<string, Row>();
  for (const row of rows) {
    const fact = row.fact;
    if (!fact || fact.fact_kind !== "boundary" || fact.boundary_type !== "input") continue;
    const identity = inputIdentity(fact.input_id, fact.event_id);
    const key = identityKey(row.session_id, identity);
    const current = starts.get(key);
    if (!current || sessionStatisticsEventOrder(row) < sessionStatisticsEventOrder(current)) {
      starts.set(key, row);
    }
  }
  return starts;
}

function nearestInputIdentity(
  row: Row,
  inputStarts: ReadonlyMap<string, Row>,
  sessionStarts: readonly Row[] | undefined,
): string | null {
  const inputId = row.input_id ?? row.fact?.input_id ?? null;
  if (inputId !== null) {
    const key = identityKey(row.session_id, `input:${inputId}`);
    if (inputStarts.has(key)) return `input:${inputId}`;
  }
  if (sessionStarts === undefined || sessionStarts.length === 0) return null;

  let nearestIndex = firstOrderAbove(sessionStarts, sessionStatisticsEventOrder(row)) - 1;
  if (nearestIndex < 0) return null;
  const nearestOrder = sessionStatisticsEventOrder(sessionStarts[nearestIndex]!);
  while (nearestIndex > 0
    && sessionStatisticsEventOrder(sessionStarts[nearestIndex - 1]!) === nearestOrder) nearestIndex -= 1;
  const nearest = sessionStarts[nearestIndex]!;
  if (!nearest.fact || nearest.fact.fact_kind !== "boundary") return null;
  return inputIdentity(nearest.fact.input_id, nearest.fact.event_id);
}

function identityForRow(
  row: Row,
  inputStarts: ReadonlyMap<string, Row>,
  startsBySession: ReadonlyMap<string, readonly Row[]>,
): string {
  if (row.missing_identity !== null) return row.missing_identity;
  const inputId = row.input_id ?? row.fact?.input_id ?? null;
  if (inputId !== null) return `input:${inputId}`;
  const nearest = nearestInputIdentity(row, inputStarts, startsBySession.get(row.session_id));
  if (nearest !== null) return nearest;
  if (row.accounting_key !== null) return `command:${row.accounting_key}`;
  const eventId = row.owner_event_id ?? row.candidate_event_id ?? row.selection_event_id;
  return `event:${String(eventId)}`;
}

function snapshotAttribution(fact: Fact | null): Attribution | null {
  const snapshot = fact?.usage_snapshot;
  if (!snapshot || !PROVIDERS.has(snapshot.provider as UsageStatsProvider)
    || (snapshot.requested_model !== null && typeof snapshot.requested_model !== "string")
    || typeof snapshot.backend !== "string") return null;
  return { provider: snapshot.provider as UsageStatsProvider, model: snapshot.requested_model as string | null };
}

function rowAttribution(
  row: Row,
  commandStarts: ReadonlyMap<string, Attribution>,
): Attribution | null {
  if (row.state === "owned" && row.fact?.fact_kind === "usage") {
    return { provider: row.fact.provider, model: row.fact.model };
  }
  return row.accounting_key !== null
    ? commandStarts.get(identityKey(row.session_id, row.accounting_key)) ?? null
    : snapshotAttribution(row.fact);
}

function commandStartAttributions(rows: readonly Row[]): Map<string, Attribution> {
  const result = new Map<string, Attribution>();
  for (const row of rows) {
    const fact = row.fact;
    if (!fact || fact.fact_kind !== "boundary" || fact.boundary_type !== "command_started"
      || row.accounting_key === null) continue;
    const attribution = snapshotAttribution(fact);
    if (attribution) result.set(JSON.stringify([row.session_id, row.accounting_key]), attribution);
  }
  return result;
}

function addEvidence(
  target: Evidence[],
  read: SessionStatisticsReadResult,
  row: Row,
  kind: EvidenceKind,
  identity: string,
  attribution: Attribution | null,
  unknownAllUsageFields: boolean,
): void {
  target.push({
    row,
    identityKey: identityKey(row.session_id, identity),
    sessionId: row.session_id,
    projectId: sessionStatisticsProjectIdForSession(read, row.session_id),
    kind,
    timestamp: rowTimestamp(row),
    eventOrder: sessionStatisticsEventOrder(row),
    attribution,
    unknownAllUsageFields,
  });
}

function mergeAttributions(records: readonly Evidence[]): Attribution | null {
  if (records.length === 0 || records.some((record) => record.attribution === null)) return null;
  const values = new Map(records.map((record) => [
    JSON.stringify([record.attribution!.provider, record.attribution!.model]),
    record.attribution!,
  ]));
  return values.size === 1 ? [...values.values()][0]! : null;
}

function collapseEvidence(records: readonly Evidence[]): Evidence[] {
  const byIdentity = new Map<string, Evidence[]>();
  for (const record of records) {
    const groupKey = JSON.stringify([record.identityKey, record.kind]);
    const group = byIdentity.get(groupKey) ?? [];
    group.push(record);
    byIdentity.set(groupKey, group);
  }
  const collapsed: Evidence[] = [];
  for (const group of byIdentity.values()) {
    const latest = [...group].sort((left, right) => right.eventOrder - left.eventOrder)[0]!;
    collapsed.push({
      ...latest,
      attribution: mergeAttributions(group),
      unknownAllUsageFields: group.some((record) => record.unknownAllUsageFields),
    });
  }
  return collapsed;
}

function isInputCoverageRow(row: Row): boolean {
  return row.row_kind === "usage"
    && row.fact === null
    && row.owner_event_id === null
    && row.candidate_type === null
    && row.representation === "diagnostic"
    && row.accounting_key === null
    && row.candidate_event_id === row.selection_event_id;
}

function ownerKey(row: Row): string {
  const ownerEventId = row.owner_event_id ?? row.candidate_event_id ?? row.selection_event_id;
  return JSON.stringify([row.session_id, String(ownerEventId)]);
}

export function createSessionStatisticsCoverageIndex(
  read: SessionStatisticsReadResult,
): SessionStatisticsCoverageIndex {
  const boundaries = boundaryRows(read);
  const inputStarts = getInputStarts(boundaries);
  const startsBySession = groupBySessionOrdered([...inputStarts.values()]);
  const sessionBoundaries = groupBySessionOrdered(boundaries);
  const commandStarts = commandStartAttributions(boundaries);
  const closures = new Map<string, Row>();
  for (const start of inputStarts.values()) {
    const startOrder = sessionStatisticsEventOrder(start);
    const closure = firstBoundaryAfter(sessionBoundaries.get(start.session_id), startOrder);
    if (!closure) continue;
    const fact = start.fact!;
    closures.set(identityKey(start.session_id, inputIdentity(fact.input_id, fact.event_id)), closure);
  }

  const ownersByKey = new Map<string, Owner>();
  const seenSourceKeys = new Set<string>();
  const seenFactlessKeys = new Set<string>();
  for (const row of read.rows) {
    if (row.row_kind !== "usage" || row.state !== "owned") continue;
    if (row.fact !== null && row.fact.fact_kind !== "usage") continue;
    const identity = identityForRow(row, inputStarts, startsBySession);
    const key = ownerKey(row);
    let owner = ownersByKey.get(key);
    if (!owner) {
      owner = {
        ownerKey: key,
        sessionId: row.session_id,
        projectId: sessionStatisticsProjectIdForSession(read, row.session_id),
        identityKey: identityKey(row.session_id, identity),
        timestamp: rowTimestamp(row),
        eventOrder: sessionStatisticsEventOrder(row),
        parts: [],
        factlessRows: [],
      };
      ownersByKey.set(key, owner);
    }
    if (row.fact) {
      const sourceKey = sessionStatisticsSourceKey(row.session_id, row.fact.event_id, row.fact.part_key);
      if (seenSourceKeys.has(sourceKey)) continue;
      seenSourceKeys.add(sourceKey);
      owner.parts.push({ row, fact: row.fact, sourceKey });
    } else {
      const factlessKey = JSON.stringify([key, row.selection_event_id, row.missing_identity]);
      if (seenFactlessKeys.has(factlessKey)) continue;
      seenFactlessKeys.add(factlessKey);
      owner.factlessRows.push(row);
    }
  }

  const terminalRecords: Evidence[] = [];
  const pendingRecords: Evidence[] = [];
  const missingCandidateKeys = new Set<string>();
  const completeUsageIdentityKeys = new Set<string>();

  for (const owner of ownersByKey.values()) {
    const complete = owner.factlessRows.length === 0
      && owner.parts.length > 0
      && owner.parts.every(({ fact }) => fact.input_total !== null && fact.output_total !== null);
    if (complete) completeUsageIdentityKeys.add(owner.identityKey);
    if (!complete) {
      const row = owner.factlessRows[0] ?? owner.parts[0]?.row;
      if (row) {
        const identity = identityForRow(row, inputStarts, startsBySession);
        missingCandidateKeys.add(identityKey(row.session_id, identity));
        addEvidence(
          terminalRecords, read, row, "terminal", identity,
          rowAttribution(row, commandStarts), owner.factlessRows.length > 0,
        );
      }
    }
  }

  for (const row of read.rows) {
    if (row.row_kind !== "usage") continue;
    if (row.state === "pending") {
      const identity = identityForRow(row, inputStarts, startsBySession);
      pendingRecords.push({
        row,
        identityKey: identityKey(row.session_id, identity),
        sessionId: row.session_id,
        projectId: sessionStatisticsProjectIdForSession(read, row.session_id),
        kind: "pending",
        timestamp: inputStarts.get(identityKey(row.session_id, identity))?.fact?.recorded_at
          ?? rowTimestamp(row),
        eventOrder: sessionStatisticsEventOrder(row),
        attribution: rowAttribution(row, commandStarts),
        unknownAllUsageFields: false,
      });
      continue;
    }
    if (row.state !== "missing" && row.state !== "ambiguous_legacy"
      && row.state !== "unresolved_legacy" && row.state !== "identity_conflict") continue;

    const identity = identityForRow(row, inputStarts, startsBySession);
    const key = identityKey(row.session_id, identity);
    missingCandidateKeys.add(key);
    if (isInputCoverageRow(row)) continue;
    addEvidence(terminalRecords, read, row, "terminal", identity, rowAttribution(row, commandStarts), true);
  }

  const terminalByIdentityKey = new Map<string, Evidence[]>();
  for (const record of terminalRecords) {
    const list = terminalByIdentityKey.get(record.identityKey);
    if (list !== undefined) list.push(record);
    else terminalByIdentityKey.set(record.identityKey, [record]);
  }

  const endedRecords: Evidence[] = [];
  for (const key of missingCandidateKeys) {
    const closure = closures.get(key);
    if (!closure?.fact || closure.fact.fact_kind !== "boundary" || completeUsageIdentityKeys.has(key)) continue;
    const start = inputStarts.get(key);
    if (!start?.fact || start.fact.fact_kind !== "boundary") continue;
    const identity = inputIdentity(start.fact.input_id, start.fact.event_id);
    const ownerEvidence = terminalByIdentityKey.get(key) ?? [];
    const attribution = mergeAttributions(ownerEvidence);
    endedRecords.push({
      row: start,
      identityKey: key,
      sessionId: start.session_id,
      projectId: sessionStatisticsProjectIdForSession(read, start.session_id),
      kind: "ended",
      timestamp: closure.fact.recorded_at,
      eventOrder: Number(closure.fact.event_id),
      attribution,
      unknownAllUsageFields: ownerEvidence.length === 0
        || ownerEvidence.some((record) => record.unknownAllUsageFields),
    });
  }

  const terminal = collapseEvidence(terminalRecords);
  const ended = collapseEvidence(endedRecords);
  const pending = collapseEvidence(pendingRecords);
  const terminalByIdentity = new Map(terminal.map((record) => [record.identityKey, record]));
  for (const record of ended) {
    const terminalRecord = terminalByIdentity.get(record.identityKey);
    if (terminalRecord) record.timestamp = terminalRecord.timestamp;
  }
  const missing = [...terminal, ...ended];
  return {
    owners: [...ownersByKey.values()].filter((owner) => sessionStatisticsInPeriod(read, owner.timestamp)),
    missing: missing.filter((record) => sessionStatisticsInPeriod(read, record.timestamp)),
    pending: pending.filter((record) => sessionStatisticsInPeriod(read, record.timestamp)),
    allMissingIdentityKeys: new Set(missing.map((record) => record.identityKey)),
  };
}

function scopeAttributionMatches(
  read: SessionStatisticsReadResult,
  attribution: Attribution | null,
  scope: SessionStatisticsScope,
): boolean {
  if (scope.respectQueryFilters !== false && read.query.provider != null
    && attribution?.provider !== read.query.provider) return false;
  if (scope.provider !== undefined && attribution?.provider !== scope.provider) return false;
  if (scope.respectQueryFilters !== false && read.query.model != null
    && attribution?.model !== read.query.model) return false;
  if (scope.model !== undefined && attribution?.model !== scope.model.value) return false;
  return true;
}

export function sessionStatisticsRowsForQuery(read: SessionStatisticsReadResult): Row[] {
  const commandStarts = commandStartAttributions(boundaryRows(read));
  const ownerMatches = new Map<string, boolean>();
  for (const row of read.rows) {
    if (row.row_kind !== "usage" || row.state !== "owned" || row.fact?.fact_kind !== "usage"
      || row.accounting_key === null) continue;
    const key = identityKey(row.session_id, row.accounting_key);
    ownerMatches.set(key, ownerMatches.get(key) === true
      || scopeAttributionMatches(read, rowAttribution(row, commandStarts), {}));
  }
  return read.rows.filter((row) => sessionStatisticsRowProjectMatches(read, row, {})
    && (((row.row_kind === "input_material" || row.row_kind === "tool_call") && row.accounting_key !== null
      ? ownerMatches.get(identityKey(row.session_id, row.accounting_key)) : undefined)
      ?? scopeAttributionMatches(read, rowAttribution(row, commandStarts), {})));
}

function evidenceMatchesScope(
  read: SessionStatisticsReadResult,
  evidence: Evidence,
  scope: SessionStatisticsScope,
): boolean {
  if (scope.respectQueryFilters !== false && read.query.project_ids !== undefined
    && !sessionStatisticsProjectMatches(evidence.projectId, read.query.project_ids)) return false;
  if (scope.projectIds !== undefined && !scope.projectIds.includes(evidence.projectId)) return false;
  return sessionStatisticsDateMatches(evidence.timestamp, scope.date);
}

function ownerPartsForScope(
  read: SessionStatisticsReadResult,
  owner: Owner,
  scope: SessionStatisticsScope,
  selectedSourceKeys: ReadonlySet<string>,
  commandStarts: ReadonlyMap<string, Attribution>,
): { parts: Owner["parts"]; factless: Row[] } {
  const parts = owner.parts.filter((part) => selectedSourceKeys.has(part.sourceKey));
  const factless = owner.factlessRows.filter((row) => {
    if (!sessionStatisticsRowProjectMatches(read, row, scope)) return false;
    if (!sessionStatisticsDateMatches(rowTimestamp(row), scope.date)) return false;
    return scopeAttributionMatches(read, rowAttribution(row, commandStarts), scope);
  });
  return { parts, factless };
}

export function sessionStatisticsCoverage(
  read: SessionStatisticsReadResult,
  index: SessionStatisticsCoverageIndex,
  scope: SessionStatisticsScope,
  selectedRows: readonly Row[],
): UsageStatsCoverage {
  const selectedSourceKeys = new Set(selectedRows.map((row) => {
    const fact = row.fact!;
    return sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
  }));

  let usageCompleteEvents = 0;
  let usagePartialEvents = 0;
  let unknownTotalTokenEvents = 0;
  let pricedEvents = 0;
  let unpricedEvents = 0;
  let pricedTokenTotal = 0;
  let unpricedTokenTotal = 0;
  let hasPricedTokens = false;
  let hasUnpricedTokens = false;
  const commandStarts = commandStartAttributions(boundaryRows(read));
  const selectedSources: SourceTokenInput[] = [];

  for (const owner of index.owners) {
    if (!sessionStatisticsRowProjectMatches(read, owner.parts[0]?.row ?? owner.factlessRows[0]!, scope)) continue;
    const timestamp = owner.timestamp;
    if (!sessionStatisticsDateMatches(timestamp, scope.date)) continue;
    const { parts, factless } = ownerPartsForScope(read, owner, scope, selectedSourceKeys, commandStarts);
    if (parts.length === 0 && factless.length === 0) continue;
    const complete = factless.length === 0
      && parts.length > 0
      && parts.every(({ fact }) => fact.input_total !== null && fact.output_total !== null);
    if (complete) usageCompleteEvents += 1;
    else usagePartialEvents += 1;
    const totalUnknown = factless.length > 0 || parts.length === 0
      || parts.some(({ fact }) => sourceTokenMetrics(fact).total_tokens === null);
    if (totalUnknown) unknownTotalTokenEvents += 1;

    const ownerPriced = parts.some(({ fact }) => fact.known_cost_usd !== null);
    const ownerUnpriced = parts.some(({ fact }) => fact.pricing_complete !== true);
    if (ownerPriced) pricedEvents += 1;
    if (ownerUnpriced) unpricedEvents += 1;
    for (const { fact } of parts) {
      selectedSources.push(fact);
      if (fact.priced_tokens !== null) {
        hasPricedTokens = true;
        pricedTokenTotal += fact.priced_tokens;
      }
      if (fact.unpriced_tokens !== null) {
        hasUnpricedTokens = true;
        unpricedTokenTotal += fact.unpriced_tokens;
      }
    }
  }

  const relatedMissing = index.missing.filter((record) => evidenceMatchesScope(read, record, scope));
  const missing = relatedMissing.filter((record) => scopeAttributionMatches(read, null, scope)
    || (record.attribution !== null && scopeAttributionMatches(read, record.attribution, scope)));
  const pending = index.pending.filter((record) => evidenceMatchesScope(read, record, scope)
    && scopeAttributionMatches(read, record.attribution, scope)
    && !index.allMissingIdentityKeys.has(record.identityKey));
  const unattributedMissingUsage = relatedMissing.some((record) => record.attribution === null);
  const countableMissing = !scopeAttributionMatches(read, null, scope)
    ? missing.filter((record) => record.attribution !== null)
    : missing;
  const countableTerminalKeys = new Set(countableMissing.filter((record) => record.kind === "terminal").map((record) => record.identityKey));
  const countableEndedKeys = new Set(countableMissing.filter((record) => record.kind === "ended").map((record) => record.identityKey));
  const countableMissingTurnKeys = new Set(countableMissing.map((record) => record.identityKey));
  const pendingKeys = new Set(pending.map((record) => record.identityKey));
  const missingAllFields = relatedMissing.some((record) => record.unknownAllUsageFields
    && (record.attribution === null || scopeAttributionMatches(read, record.attribution, scope)));

  return {
    usage_complete_events: usageCompleteEvents,
    usage_partial_events: usagePartialEvents,
    terminal_missing_usage: countableTerminalKeys.size,
    ended_input_without_usage: countableEndedKeys.size,
    missing_usage_turns: countableMissingTurnKeys.size,
    pending_inputs: pendingKeys.size,
    priced_events: pricedEvents,
    unpriced_events: unpricedEvents,
    priced_total_tokens: hasPricedTokens ? pricedTokenTotal : null,
    unpriced_total_tokens: hasUnpricedTokens ? unpricedTokenTotal : null,
    unknown_total_token_events: unknownTotalTokenEvents,
    unattributed_missing_usage: unattributedMissingUsage,
    token_partials: foldTokenPartials(selectedSources, missingAllFields),
  };
}
