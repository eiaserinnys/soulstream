import { isPersistentJevCandidatesDebugEvent as isWirePersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";
import { projectCacheKeepaliveTurns } from "./persistent-cache-keepalive";

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

export interface PersistentChatDisplaySettings {
  show_generation_separator: boolean;
  show_jev_candidates: boolean;
}

/** Applies PAS visibility after flattening, retaining each visible message object. */
export function projectPersistentChatDisplayMessages<T extends { treeNodeType: string; cacheKeepalive?: boolean }>(
  messages: T[],
  settings: PersistentChatDisplaySettings | null,
): T[] {
  return projectCacheKeepaliveTurns(messages).filter((message) => {
    if (message.treeNodeType === "generation_started") {
      return settings?.show_generation_separator === true;
    }
    if (message.treeNodeType === "persistent_jev_candidates") {
      return settings?.show_jev_candidates === true;
    }
    return true;
  });
}

export function isPersistentJevCandidatesDebugEvent(
  value: unknown,
): value is { type: "debug"; kind: "persistent_jev_candidates"; observation: PersistentJevObservation; timestamp?: number } {
  return isWirePersistentJevCandidatesDebugEvent(value);
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
