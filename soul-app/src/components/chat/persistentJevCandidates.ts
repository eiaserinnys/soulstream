import type { SessionEvent } from '../../api/types';

export interface PersistentJevCandidate {
  kind: 'turn_summary' | 'card' | 'session';
  label: string;
  line: string;
  score: number;
}

export interface PersistentJevObservation {
  input_id: string;
  selected: PersistentJevCandidate[];
}

/** App-side wire guard until the shared wire-schema guard reaches main. */
export function isPersistentJevCandidatesDebugEvent(
  event: SessionEvent,
): event is SessionEvent & { data: { kind: 'persistent_jev_candidates'; observation: PersistentJevObservation } } {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const boundedText = (value: unknown, maxLength: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  const positiveInteger = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

  if (event.type !== 'debug' || !isRecord(event.data)
    || event.data.kind !== 'persistent_jev_candidates'
    || !isRecord(event.data.observation)) return false;

  const observation = event.data.observation;
  if (!exactKeys(observation, ['input_id', 'selected', 'candidate_counts', 'model', 'latency_ms'])
    || typeof observation.input_id !== 'string' || observation.input_id.length === 0
    || observation.model !== 'jev-latest'
    || typeof observation.latency_ms !== 'number' || !Number.isSafeInteger(observation.latency_ms) || observation.latency_ms < 0
    || !isRecord(observation.candidate_counts)
    || !exactKeys(observation.candidate_counts, ['turn_summaries', 'cards', 'search_sessions', 'recent_completed_sessions'])) return false;

  const limits = { turn_summaries: 40, cards: 20, search_sessions: 15, recent_completed_sessions: 5 };
  if (!Object.entries(limits).every(([key, limit]) => {
    const count = observation.candidate_counts[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= limit;
  })) return false;

  if (!Array.isArray(observation.selected) || observation.selected.length > 5) return false;
  return observation.selected.every((candidate) => {
    if (!isRecord(candidate) || !boundedText(candidate.label, 120) || !boundedText(candidate.line, 240)
      || typeof candidate.score !== 'number' || !Number.isSafeInteger(candidate.score) || candidate.score < 2 || candidate.score > 3) return false;
    if (candidate.kind === 'turn_summary') {
      return exactKeys(candidate, ['kind', 'session_id', 'summary_event_id', 'turn_number', 'label', 'line', 'score'])
        && typeof candidate.session_id === 'string' && candidate.session_id.length > 0
        && positiveInteger(candidate.summary_event_id) && positiveInteger(candidate.turn_number)
        && boundedText(candidate.label, 32);
    }
    if (candidate.kind === 'card') {
      return exactKeys(candidate, ['kind', 'card_id', 'label', 'line', 'score'], ['card_number'])
        && typeof candidate.card_id === 'string' && candidate.card_id.length > 0
        && (candidate.card_number === undefined || positiveInteger(candidate.card_number))
        && boundedText(candidate.label, 80);
    }
    if (candidate.kind === 'session') {
      return exactKeys(candidate, ['kind', 'session_id', 'label', 'line', 'score'], ['sources'])
        && typeof candidate.session_id === 'string' && candidate.session_id.length > 0
        && (candidate.sources === undefined || (Array.isArray(candidate.sources)
          && candidate.sources.length >= 1 && candidate.sources.length <= 2
          && new Set(candidate.sources).size === candidate.sources.length
          && candidate.sources.every((source) => source === 'search' || source === 'recent_completed')));
    }
    return false;
  });
}

export function persistentJevCaptionLines(observation: PersistentJevObservation): string[] {
  if (observation.selected.length === 0) return ['2점 이상인 후보가 없습니다.'];
  return observation.selected.map((candidate) =>
    `${candidate.label} · ${candidate.line} · ${candidate.score}/3`.replace(/\s+/g, ' ').trim(),
  );
}
