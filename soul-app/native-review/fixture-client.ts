import type { ApiClient } from '../src/api/client';
import type { CardCheckItem, CardDetail } from '../src/api/cardTypes';
import type { PersistentSessionResource } from '../src/api/persistentSessionEndpoints';
import type { PersistentReportEntry, Session } from '../src/api/types';
import { createReviewApi } from '../src/component-review/fixtures';
import { dialogueMessages } from '../src/component-review/chat-fixtures';
import { cardFixture } from '../src/test-support/cards';

export const sessionId = 'native-pas-layout';
export const cardKey = 'card_native_layout';
const cardId = 'native-layout-card';
const at = '2026-10-01T00:00:00Z';
export const entries: PersistentReportEntry[] = [{
  key: cardKey, card_id: cardId, card_status: 'review', kind: 'see', title: '카드 장 화면 확인',
  context: '결과와 확인 항목을 살펴봐 주세요.', action: '', options: [], state: 'open', answer: '',
  card_numbers: [812], updated_at: at,
}];
export const session: PersistentSessionResource = {
  session_id: sessionId, display_name: '영구 관제 세션', node_id: null, folder_id: null,
  agent_id: null, agent_name: '서소영', persistent: true, persistent_report: entries,
  settings: { default_model: { model_preset: null, reasoning_effort: null }, turn_usage_mode: 'collapsed',
    show_character: true, animate_character: false, show_generation_separator: true },
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};
export const sessionSummary: Session = {
  agentSessionId: sessionId, displayName: '영구 관제 세션', status: 'idle', agentName: '서소영',
  createdAt: at, updatedAt: at,
};
const items: CardCheckItem[] = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1, title: `확인 항목 ${index + 1}: 장 안의 결과를 확인합니다`, state: 'done',
  result: '내용을 펼친 상태에서도 입력창과 초상화의 위치를 살펴봅니다.', evidence: [], caveat: null,
  rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at,
  reportedAt: at, display: 'reported',
}));
const card = cardFixture({ id: cardId, number: 812, status: 'review', title: '카드 장 화면 확인', items,
  nodeId: null, assigneeSessionId: sessionId,
  now: { text: '검증할 결과를 준비했습니다.', turn: 'user', ask: '확인해 주세요.', updatedAt: at, sessionId } });
const detail: CardDetail = { card, reports: [], questions: [], sessions: [], nowHistory: [], comments: [
  { id: 'native-comment-1', cardId, authorKind: 'user', authorId: null, sessionId: null,
    kind: 'comment', body: '펼친 장과 대화 위치를 확인합니다.', createdAt: at },
  { id: 'native-comment-2', cardId, authorKind: 'agent', authorId: null, sessionId,
    kind: 'comment', body: '확인 항목을 준비했습니다.', createdAt: '2026-10-01T00:01:00Z' },
] };
const base = createReviewApi();
const api = {
  ...base,
  sessionEventsUrl: () => '',
  getPersistentSession: async () => ({ session }),
  getSessionsByIds: async () => [sessionSummary],
  getTimeline: async (_id: string, params?: { before?: string }) => ({ messages: params?.before ? [] : dialogueMessages, next_cursor: null }),
  listCards: async () => ({ cards: [card] }),
  getCard: async () => detail,
} as unknown as ApiClient;

// This module is selected only by the native-review Metro resolver. It has no HTTP transport.
export function createApiClient(): ApiClient { return api; }
