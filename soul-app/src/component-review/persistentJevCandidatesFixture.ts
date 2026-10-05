import type { SessionEvent } from '../api/types';

const selectedCandidates = [
  { kind: 'turn_summary', session_id: 'fixture-session', summary_event_id: 38, turn_number: 38, label: 'T38', line: '요약 한 줄', score: 3 },
  { kind: 'card', card_id: 'fixture-card-id', card_number: 412, label: '#412', line: '카드 한 줄', score: 2 },
  { kind: 'session', session_id: 'fixture-session-2', label: '세션 제목', line: '한 줄', score: 2 },
];

export function persistentJevCandidatesFixture(
  eventId: string,
  inputId: string,
  options: { selectedCount?: number; longLine?: boolean } = {},
): SessionEvent {
  const selected = selectedCandidates.slice(0, options.selectedCount ?? selectedCandidates.length);
  if (options.longLine && selected[0]) {
    selected[0] = {
      ...selected[0],
      line: '이 후보의 긴 요약은 좁은 화면과 넓은 화면에서 한 줄 말줄임 처리가 적용되는지 실제 캡션에서 확인하기 위해 일부러 길게 작성한 문장입니다. 후보 내용이 길어져도 줄바꿈 대신 오른쪽 끝에서 말줄임 표시가 유지되는지 볼 수 있도록 충분히 긴 문장을 넣었습니다.',
    };
  }
  return {
    id: eventId,
    type: 'debug',
    data: {
      kind: 'persistent_jev_candidates',
      observation: {
        input_id: inputId,
        selected,
        candidate_counts: { turn_summaries: 40, cards: 20, search_sessions: 15, recent_completed_sessions: 5 },
        model: 'jev-latest',
        latency_ms: 426,
      },
    },
  };
}
