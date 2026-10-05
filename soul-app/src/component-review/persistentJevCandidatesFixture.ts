import type { SessionEvent } from '../api/types';

const selectedCandidates = [
  { kind: 'turn_summary', session_id: 'fixture-session', summary_event_id: 38, turn_number: 38, label: 'T38', line: '요약 한 줄', score: 3 },
  { kind: 'card', card_id: 'fixture-card-id', card_number: 412, label: '#412', line: '카드 한 줄', score: 2 },
  { kind: 'session', session_id: 'fixture-session-2', label: '세션 제목', line: '한 줄', score: 2 },
];

export function persistentJevCandidatesFixture(
  eventId: string,
  inputId: string,
  selectedCount = selectedCandidates.length,
): SessionEvent {
  return {
    id: eventId,
    type: 'debug',
    data: {
      kind: 'persistent_jev_candidates',
      observation: {
        input_id: inputId,
        selected: selectedCandidates.slice(0, selectedCount),
        candidate_counts: { turn_summaries: 40, cards: 20, search_sessions: 15, recent_completed_sessions: 5 },
        model: 'jev-latest',
        latency_ms: 426,
      },
    },
  };
}
