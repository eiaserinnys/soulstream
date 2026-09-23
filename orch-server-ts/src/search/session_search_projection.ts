import {
  buildSearchPreview,
  buildSessionSearchUrl,
  compactSearchQuery,
} from "@soulstream/search-contract";

export type SessionSearchCandidateRow = Record<string, unknown>;

export type SessionSearchResult = {
  readonly session_id: string;
  readonly folder_id: string | null;
  readonly node_id: string | null;
  readonly status: string | null;
  readonly backend: string | null;
  readonly agent_name: string | null;
  readonly review_required: boolean;
  readonly title: string;
  readonly excerpt: string;
  readonly updated_at: string | null;
  readonly task_id: string | null;
  readonly task_title: string | null;
  readonly parent_session_id: string | null;
  readonly best_match: {
    readonly event_id: number | null;
    readonly match_source: string;
    readonly excerpt: string;
  };
  readonly evidence: readonly {
    readonly source: string;
    readonly event_id: number | null;
    readonly excerpt: string;
  }[];
  readonly session_url: string;
};

type ScoredCandidate = {
  readonly sessionId: string;
  readonly score: number;
  readonly queryFamily: "lexical" | "semantic";
  readonly queryRank: number;
  readonly evidence: SessionSearchResult["evidence"][number];
  readonly row: SessionSearchCandidateRow;
};

export function projectSessionSearchResults(
  rows: readonly SessionSearchCandidateRow[],
  originalQuery: string,
  candidateLimit: number,
): SessionSearchResult[] {
  const sourceBuckets = new Map<string, SessionSearchCandidateRow[]>();
  for (const row of rows) {
    if (!stringValue(row.session_id)) continue;
    const queryKind = stringValue(row.query_kind) ?? "original";
    const matchSource = stringValue(row.match_source) ?? "message";
    const relevanceSource = stringValue(row.relevance_source) ?? matchSource;
    const bucketKey = `${queryKind}:${relevanceSource}`;
    const bucket = sourceBuckets.get(bucketKey) ?? [];
    bucket.push(row);
    sourceBuckets.set(bucketKey, bucket);
  }

  const bestPerSessionAndFamily = new Map<string, ScoredCandidate>();
  for (const [bucketKey, bucket] of sourceBuckets) {
    const queryKind = baseQueryKind(bucketKey.slice(0, bucketKey.indexOf(":")));
    const baseQueryFamily = isSemanticQuery(queryKind) ? "semantic" : "lexical";
    const weight = queryWeight(queryKind) * relevanceSourceWeight(
      bucketKey.slice(bucketKey.indexOf(":") + 1),
    );
    const orderedRows = bucket.sort((left, right) =>
      numberValue(right.score) - numberValue(left.score)
      || (stringValue(right.session_updated_at) ?? "")
        .localeCompare(stringValue(left.session_updated_at) ?? "")
      || (stringValue(left.session_id) ?? "").localeCompare(stringValue(right.session_id) ?? "")
      || numberValue(left.id) - numberValue(right.id));
    const seenSessions = new Set<string>();
    let queryRank = 0;
    let previousRawScore: number | undefined;
    for (const row of orderedRows) {
      const sessionId = stringValue(row.session_id);
      if (!sessionId || seenSessions.has(sessionId)) continue;
      seenSessions.add(sessionId);
      const rawScore = numberValue(row.score);
      if (previousRawScore === undefined || rawScore < previousRawScore) queryRank += 1;
      previousRawScore = rawScore;
      const rawExcerpt = stringValue(row.searchable_text)
        ?? stringValue(row.display_name)
        ?? stringValue(row.session_prompt)
        ?? "";
      const matchSource = stringValue(row.match_source) ?? "message";
    const isEventAnchor = matchSource === "message" || matchSource === "turn_summary";
    const evidence: SessionSearchResult["evidence"][number] = {
      source: matchSource,
        event_id: isEventAnchor ? numberValueOrNull(row.id) : null,
        excerpt: buildSearchPreview(rawExcerpt, originalQuery),
      };
      keepBestCandidate(bestPerSessionAndFamily, {
        sessionId,
        score: weight / (60 + queryRank),
        queryFamily: baseQueryFamily,
        queryRank,
        evidence,
        row,
      });
    }
  }

  addPrimaryTaskTitleMatches(bestPerSessionAndFamily, rows, originalQuery);

  const bySession = new Map<string, ScoredCandidate[]>();
  for (const candidate of bestPerSessionAndFamily.values()) {
    const group = bySession.get(candidate.sessionId) ?? [];
    group.push(candidate);
    bySession.set(candidate.sessionId, group);
  }

  return [...bySession.values()]
    .map((group) => {
      const best = [...group].sort((left, right) => right.score - left.score)[0]!;
      const row = best.row;
      const sessionId = best.sessionId;
      const displayName = stringValue(row.display_name)?.trim();
      const prompt = stringValue(row.session_prompt)?.trim();
      const title = displayName || firstLine(prompt ?? null) || "제목 없음";
      const excerpt = best.evidence.excerpt || buildSearchPreview(prompt ?? "", originalQuery);
      const explicitTaskEvidence = taskEvidenceForSession(rows, sessionId, originalQuery);
      const evidence = uniqueEvidence([
        ...group.map((candidate) => candidate.evidence),
        ...explicitTaskEvidence,
      ]);
      const eventId = best.evidence.event_id;
      return {
        session_id: sessionId,
        folder_id: stringValue(row.folder_id),
        node_id: stringValue(row.node_id),
        status: stringValue(row.status),
        backend: stringValue(row.backend),
        agent_name: stringValue(row.agent_name),
        review_required: row.review_required === true,
        title,
        excerpt,
        updated_at: stringValue(row.session_updated_at),
        task_id: stringValue(row.task_id),
        task_title: stringValue(row.task_title),
        parent_session_id: stringValue(row.parent_session_id)
          ?? stringValue(row.caller_session_id),
        best_match: {
          event_id: eventId,
          match_source: best.evidence.source,
          excerpt,
        },
        evidence,
        session_url: buildSessionSearchUrl({
          sessionId,
          ...(eventId === null ? {} : { eventId: String(eventId) }),
        }),
        relevance: group.reduce((sum, candidate) => sum + candidate.score, 0),
        workEvidenceRank: explicitTaskEvidence.reduce(
          (rank, item) => Math.max(rank, taskEvidenceRank(item.source)),
          0,
        ),
      };
    })
    .sort((left, right) => right.relevance - left.relevance
      || right.workEvidenceRank - left.workEvidenceRank
      || (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
      || left.session_id.localeCompare(right.session_id))
    .slice(0, candidateLimit)
    .map(({ relevance: _relevance, workEvidenceRank: _workEvidenceRank, ...result }) => result);
}

function keepBestCandidate(
  candidates: Map<string, ScoredCandidate>,
  candidate: ScoredCandidate,
): void {
  const key = `${candidate.sessionId}:${candidate.queryFamily}`;
  const current = candidates.get(key);
  if (!current || candidate.score > current.score) candidates.set(key, candidate);
}

function addPrimaryTaskTitleMatches(
  candidates: Map<string, ScoredCandidate>,
  rows: readonly SessionSearchCandidateRow[],
  originalQuery: string,
): void {
  const compactQuery = compactSearchQuery(originalQuery);
  if (!compactQuery) return;
  const bestBySession = new Map<string, SessionSearchCandidateRow>();
  for (const row of rows) {
    const sessionId = stringValue(row.session_id);
    const taskId = stringValue(row.task_id);
    const title = stringValue(row.task_title)?.trim();
    if (!sessionId || !taskId || !title || !compactSearchQuery(title).includes(compactQuery)) continue;
    if (!bestBySession.has(sessionId)) bestBySession.set(sessionId, row);
  }
  for (const [queryRank, [sessionId, row]] of [...bestBySession.entries()].entries()) {
    const title = stringValue(row.task_title) ?? "";
    keepBestCandidate(candidates, {
      sessionId,
      score: 1.5 / (60 + queryRank + 1),
      queryFamily: "lexical",
      queryRank: queryRank + 1,
      evidence: {
        source: "task_title",
        event_id: null,
        excerpt: buildSearchPreview(title, originalQuery),
      },
      row,
    });
  }
}

function taskEvidenceForSession(
  rows: readonly SessionSearchCandidateRow[],
  sessionId: string,
  originalQuery: string,
): SessionSearchResult["evidence"] {
  const evidenceByKind = new Map<string, SessionSearchCandidateRow>();
  for (const row of rows) {
    if (stringValue(row.session_id) !== sessionId) continue;
    const kind = stringValue(row.task_evidence_kind);
    const title = stringValue(row.task_evidence_title)?.trim();
    if (!kind || !title || !isTaskEvidenceKind(kind)) continue;
    if (!evidenceByKind.has(kind)) evidenceByKind.set(kind, row);
  }
  return [...evidenceByKind.entries()]
    .sort(([left], [right]) => taskEvidenceRank(right) - taskEvidenceRank(left))
    .map(([kind, row]) => ({
      source: kind,
      event_id: null,
      excerpt: buildSearchPreview(stringValue(row.task_evidence_title) ?? "", originalQuery),
    }));
}

function isTaskEvidenceKind(kind: string): boolean {
  return kind === "source_task_item"
    || kind === "task_item_completed"
    || kind === "task_completed"
    || kind === "task_item_assigned";
}

function taskEvidenceRank(kind: string): number {
  return kind === "task_item_completed" || kind === "task_completed" ? 2 : 0;
}

function isSemanticQuery(queryKind: string): boolean {
  return queryKind === "semantic" || queryKind.startsWith("semantic_");
}

function baseQueryKind(queryKind: string): string {
  return queryKind.startsWith("session_candidate_")
    ? queryKind.slice("session_candidate_".length)
    : queryKind;
}

function queryWeight(queryKind: string): number {
  if (queryKind === "original") return 2;
  if (queryKind === "normalized" || queryKind === "compact") return 1.5;
  if (isSemanticQuery(queryKind)) return 1;
  return 1.5;
}

function relevanceSourceWeight(source: string): number {
  switch (source) {
    case "title": return 1.75;
    case "initial_request": return 1.5;
    case "prompt": return 1.35;
    case "session_id": return 1.25;
    case "user_message": return 0.9;
    case "assistant_message": return 0.65;
    default: return 1;
  }
}

function uniqueEvidence(
  evidence: readonly SessionSearchResult["evidence"][number][],
): SessionSearchResult["evidence"] {
  const unique = new Map<string, SessionSearchResult["evidence"][number]>();
  for (const item of evidence) {
    const key = `${item.source}:${item.event_id ?? ""}`;
    if (!unique.has(key)) unique.set(key, item);
    if (unique.size >= 3) break;
  }
  return [...unique.values()];
}

function firstLine(value: string | null): string | null {
  if (!value) return null;
  const line = value.split(/\r?\n/, 1)[0]?.trim();
  return line || null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numberValueOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed > 0 ? parsed : null;
}
