import {
  buildSearchPreview,
  buildSessionSearchUrl,
  compactSearchQuery,
} from "@soulstream/search-contract";

export type SessionSearchCandidateRow = Record<string, unknown>;

export type SessionSearchResult = {
  readonly session_id: string;
  readonly folder_id: string | null;
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
  readonly queryFamily: "lexical" | "semantic" | "user_message";
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
    const eventType = stringValue(row.event_type) ?? "";
    const bucketKey = `${queryKind}:${matchSource}:${eventType}`;
    const bucket = sourceBuckets.get(bucketKey) ?? [];
    bucket.push(row);
    sourceBuckets.set(bucketKey, bucket);
  }

  const bestPerSessionAndFamily = new Map<string, ScoredCandidate>();
  for (const [bucketKey, bucket] of sourceBuckets) {
    const queryKind = baseQueryKind(bucketKey.slice(0, bucketKey.indexOf(":")));
    const baseQueryFamily = isSemanticQuery(queryKind) ? "semantic" : "lexical";
    const queryFamilyForRows = stringValue(bucket[0]?.event_type) === "user_message"
      ? "user_message"
      : baseQueryFamily;
    const weight = queryFamilyForRows === "user_message" ? 0.5 : queryWeight(queryKind);
    const orderedRows = bucket.sort((left, right) =>
      numberValue(right.score) - numberValue(left.score)
      || (stringValue(right.session_updated_at) ?? "")
        .localeCompare(stringValue(left.session_updated_at) ?? "")
      || (stringValue(left.session_id) ?? "").localeCompare(stringValue(right.session_id) ?? "")
      || numberValue(left.id) - numberValue(right.id));
    const seenSessions = new Set<string>();
    let queryRank = 0;
    for (const row of orderedRows) {
      const sessionId = stringValue(row.session_id);
      if (!sessionId || seenSessions.has(sessionId)) continue;
      seenSessions.add(sessionId);
      queryRank += 1;
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
        queryFamily: queryFamilyForRows,
        queryRank,
        evidence,
        row,
      });
    }
  }

  addLinkedTaskEvidence(bestPerSessionAndFamily, rows, originalQuery);

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
      const evidence = uniqueEvidence(group.map((candidate) => candidate.evidence));
      const eventId = best.evidence.event_id;
      return {
        session_id: sessionId,
        folder_id: stringValue(row.folder_id),
        title,
        excerpt,
        updated_at: stringValue(row.session_updated_at),
        task_id: stringValue(row.task_id),
        task_title: stringValue(row.task_title),
        parent_session_id: stringValue(row.predecessor_session_id),
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
      };
    })
    .sort((left, right) => right.relevance - left.relevance
      || (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
      || left.session_id.localeCompare(right.session_id))
    .slice(0, candidateLimit)
    .map(({ relevance: _relevance, ...result }) => result);
}

function keepBestCandidate(
  candidates: Map<string, ScoredCandidate>,
  candidate: ScoredCandidate,
): void {
  const key = `${candidate.sessionId}:${candidate.queryFamily}`;
  const current = candidates.get(key);
  if (!current || candidate.score > current.score) candidates.set(key, candidate);
}

function addLinkedTaskEvidence(
  candidates: Map<string, ScoredCandidate>,
  rows: readonly SessionSearchCandidateRow[],
  originalQuery: string,
): void {
  const compactQuery = compactSearchQuery(originalQuery);
  if (!compactQuery) return;
  const bestTaskBySession = new Map<string, SessionSearchCandidateRow>();
  for (const row of rows) {
    const sessionId = stringValue(row.session_id);
    const taskTitle = stringValue(row.task_title)?.trim();
    if (!sessionId || !stringValue(row.task_id) || !taskTitle) continue;
    const compactTitle = compactSearchQuery(taskTitle);
    if (!compactTitle.includes(compactQuery)) continue;
    const previous = bestTaskBySession.get(sessionId);
    if (!previous || taskTitleMatchRank(taskTitle, originalQuery)
      < taskTitleMatchRank(stringValue(previous.task_title) ?? "", originalQuery)) {
      bestTaskBySession.set(sessionId, row);
    }
  }

  const orderedTasks = [...bestTaskBySession.entries()].sort((left, right) =>
    taskTitleMatchRank(stringValue(left[1].task_title) ?? "", originalQuery)
      - taskTitleMatchRank(stringValue(right[1].task_title) ?? "", originalQuery)
    || (stringValue(right[1].session_updated_at) ?? "")
      .localeCompare(stringValue(left[1].session_updated_at) ?? "")
    || left[0].localeCompare(right[0]));
  for (const [queryRank, [sessionId, row]] of orderedTasks.entries()) {
    const taskTitle = stringValue(row.task_title) ?? "";
    keepBestCandidate(candidates, {
      sessionId,
      score: 1.5 / (60 + queryRank + 1),
      queryFamily: "lexical",
      queryRank: queryRank + 1,
      evidence: {
        source: "task",
        event_id: null,
        excerpt: buildSearchPreview(taskTitle, originalQuery),
      },
      row,
    });
  }
}

function taskTitleMatchRank(taskTitle: string, originalQuery: string): number {
  const title = compactSearchQuery(taskTitle);
  const query = compactSearchQuery(originalQuery);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  return 2;
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
