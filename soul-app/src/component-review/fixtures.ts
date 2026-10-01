import type { ApiClient } from '../api/client';
import type { CardDto, CardStatus } from '../api/cardTypes';
import type { CatalogFolder, Session, SessionEvent } from '../api/types';
import type { PlannerFolder } from '../api/plannerTypes';

// Invented public data only. No IDs or assets from an actual account.
const time = '2026-10-01T00:00:00Z';
export const folders: CatalogFolder[] = [
  { id: 'public-project', name: '공개 예시 프로젝트', parentFolderId: null, sortOrder: 0,
    projectPageId: null, settings: {}, archived: false, status: 'open', version: 1 },
  { id: 'public-child', name: '길이가 긴 폴더 이름의 줄바꿈과 말줄임을 확인하는 공개 예시',
    parentFolderId: 'public-project', sortOrder: 1, projectPageId: null,
    settings: {}, archived: false, status: 'open', version: 1 },
];
export const sessions: Session[] = [
  { agentSessionId: 'public-running', displayName: '현재 실행 중인 공개 예시 세션',
    status: 'running', agentName: '예시 에이전트', backend: 'codex', modelLabel: '예시 모델',
    createdAt: time, updatedAt: time },
  { agentSessionId: 'public-review', displayName: '결과를 확인할 공개 예시 세션',
    status: 'completed', agentName: '예시 에이전트', reviewRequired: true,
    reviewState: 'needs_review', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-idle', displayName: '대기 중인 공개 예시 세션',
    status: 'idle', agentName: '예시 에이전트', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-error', displayName: '오류가 표시된 공개 예시 세션',
    status: 'error', agentName: '예시 에이전트', createdAt: time, updatedAt: time },
  { agentSessionId: 'public-attention', displayName: '사용자 응답이 필요한 공개 예시 세션',
    status: 'running', agentName: '예시 에이전트', createdAt: time, updatedAt: time,
    pendingAttentions: [{ id: 'public-question', sourceEventId: 1, sessionId: 'public-attention',
      kind: 'input_request', requestedAt: time, title: '공개 질문 예시', body: '확인해주세요.',
      requiresDetail: false }] },
];
export function makeCard(status: CardStatus): CardDto {
  return { id: 'public-' + status, folderId: folders[0].id,
    title: '현재 카드 행을 검수하는 공개 예시', request: '공개 fixture로 표시와 동작을 확인합니다.',
    brief: '', status, positionKey: 'a', queuePositionKey: null,
    blockedKind: status === 'blocked' ? 'question' : null, blockedDetail: null,
    assigneeKind: 'agent', assigneeAgentId: 'public-agent', assigneeSessionId: null,
    assigneeUserId: null, nodeId: null, modelPreset: '예시 모델',
    archived: false, version: 1, createdAt: time, updatedAt: time };
}
export const initialCards = (['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'] as const).map(makeCard);
export const starredFolders: PlannerFolder[] = folders.map((folder) => ({
  page: { id: folder.id, title: folder.name, dailyDate: null, version: 1,
    archived: false, metadata: {}, createdAt: time, updatedAt: time },
  blocks: [], folderId: folder.id, folderSummary: null, status: 'open', assignee: '',
  contextCount: 0, progress: null, projectPageId: null, sessions: [], sessionIds: [],
}));
export type FixtureState = 'normal' | 'empty' | 'error' | 'loading';
export const fixtureOptions = [
  { value: 'normal', label: '기본' }, { value: 'empty', label: '빈 목록' },
  { value: 'error', label: '조회 실패' }, { value: 'loading', label: '로딩' },
] as const;

export function createReviewApi(state: FixtureState = 'normal') {
  const cards = new Map(initialCards.map((card) => [card.id, { ...card }]));
  const read = async <T,>(value: T): Promise<T> => {
    if (state === 'error') throw new Error('공개 예시: 목록을 불러오지 못했습니다.');
    if (state === 'loading') return new Promise(() => {});
    return value;
  };
  const api: Pick<ApiClient, 'listCards' | 'getCard' | 'setCardStatus' | 'getStarredFolders' | 'listNodes' | 'listNodeAgents' | 'listModelPresets'> = {
    listCards: async (folderId) => read({ cards: state === 'empty' ? [] : [...cards.values()].filter((card) => !folderId || card.folderId === folderId) }),
    getCard: async (id) => {
      const card = cards.get(id);
      if (!card) throw new Error('알 수 없는 공개 예시 카드');
      return { card, reports: [], comments: [], questions: [], sessions: [] };
    },
    setCardStatus: async (id, status) => {
      const current = cards.get(id);
      if (!current) throw new Error('알 수 없는 공개 예시 카드');
      const card = { ...current, status, version: current.version + 1 };
      cards.set(id, card);
      return { folderId: card.folderId, card };
    },
    getStarredFolders: async () => read({ items: state === 'empty' ? [] : starredFolders, nextCursor: null }),
    listNodes: async () => read({ nodes: state === 'empty' ? [] : [{ nodeId: 'public-node' }, { nodeId: 'public-other-node' }] }),
    listNodeAgents: async () => read({ agents: state === 'empty' ? [] : [
      { id: 'public-agent', name: '공개 예시 에이전트', default_preset: 'public-model' },
      { id: 'public-other-agent', name: '다른 예시 에이전트', default_preset: 'public-model' },
    ] }),
    listModelPresets: async () => read({ model_presets: state === 'empty' ? [] : [
      { id: 'public-model', label: '사용 가능한 예시 모델', backend: 'codex', available: true,
        reason: null, reason_label: null, resets_at: null, usage_warning: false },
      { id: 'public-unavailable-model', label: '사용 불가 예시 모델', backend: 'codex', available: false,
        reason: 'limit', reason_label: '공개 예시: 사용량 한도', resets_at: null, usage_warning: false },
    ] }),
  };
  // Existing injected API contracts accept ApiClient. This object implements
  // only the methods the samples use and has no transport or fallback client.
  return api as ApiClient;
}
export function message(type: SessionEvent['type'], text: string): SessionEvent {
  return { id: 'public-' + type, type, data: { text } };
}
export const guidance = '이 프로젝트는 공개 fixture만 사용합니다.\n현재 앱의 표시와 상호작용을 확인합니다.\n'.repeat(6);
