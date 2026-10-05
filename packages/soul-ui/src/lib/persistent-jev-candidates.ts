export interface PersistentJevCandidate {
  label: string;
  line: string;
  score: number;
}

export interface PersistentJevObservation {
  input_id: string;
  selected: PersistentJevCandidate[];
}

export interface PersistentJevCandidatesProjectionItem {
  treeNodeId: string;
  treeNodeType: string;
  eventId?: number;
  inputId?: string;
  preparedInputId?: string;
}

/** Temporary web boundary guard; replace its body with the shared wire guard after PR #1271 merges. */
export function isPersistentJevCandidatesDebugEvent(
  value: unknown,
): value is { type: "debug"; kind: "persistent_jev_candidates"; observation: PersistentJevObservation; timestamp?: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== "debug" || event.kind !== "persistent_jev_candidates") return false;
  const observation = event.observation;
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return false;
  const raw = observation as Record<string, unknown>;
  if (typeof raw.input_id !== "string" || raw.input_id.length === 0 || !Array.isArray(raw.selected) || raw.selected.length > 5) return false;
  return raw.selected.every((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    return (row.kind === "turn_summary" || row.kind === "card" || row.kind === "session")
      && typeof row.label === "string"
      && typeof row.line === "string"
      && (row.score === 2 || row.score === 3);
  });
}

export function formatPersistentJevCandidates(observation: Pick<PersistentJevObservation, "selected">): string[] {
  if (observation.selected.length === 0) return ["2점 이상인 후보가 없습니다."];
  return observation.selected.slice(0, 5).map((candidate) => (
    `${candidate.label} · ${candidate.line} · ${candidate.score}/3`
  ));
}

/** Input-scoped records remain in the tree; this only projects records whose exact input is loaded. */
export function placePersistentJevCandidatesAtInputAnchors<
  T extends PersistentJevCandidatesProjectionItem,
>(items: T[]): T[] {
  const isCandidate = (item: T) => item.treeNodeType === "persistent_jev_candidates";
  const timeline = items.filter((item) => !isCandidate(item));
  const inputIndexById = new Map<string, number>();
  timeline.forEach((item, index) => {
    if ((item.treeNodeType === "user_message" || item.treeNodeType === "intervention")
      && typeof item.inputId === "string" && item.inputId.length > 0) {
      inputIndexById.set(item.inputId, index);
    }
  });

  const after = new Map<number, T[]>();
  for (const item of items) {
    if (!isCandidate(item)
      || typeof item.preparedInputId !== "string" || item.preparedInputId.length === 0
      || typeof item.eventId !== "number" || !Number.isSafeInteger(item.eventId) || item.eventId <= 0) continue;
    const anchor = inputIndexById.get(item.preparedInputId);
    if (anchor === undefined) continue;
    const bucket = after.get(anchor) ?? [];
    bucket.push(item);
    after.set(anchor, bucket);
  }
  for (const bucket of after.values()) bucket.sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0));

  const ordered: T[] = [];
  timeline.forEach((item, index) => ordered.push(item, ...(after.get(index) ?? [])));
  return ordered;
}
