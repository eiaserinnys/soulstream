import type { ApiClient } from '../api/client';
import type { FeedPage } from '../api/feedPage';
import { Alert, Platform, type AlertButton } from 'react-native';
import type { CardCheckItem, CardComment, CardDetail, CardDto, CardMutationResult, CardPatch, CardStatus } from '../api/cardTypes';
import { Asset } from 'expo-asset';
import {
  createReviewApi,
  entryShellFolders,
  entryShellSessions,
  folderTabReviewFolders,
  folders,
  makeCard,
  starredFolders,
  type ReviewCardMutation,
} from './fixtures';
import {
  currentFeedFixtureState,
  feedFixturePage,
  feedFixtureSessionLookup,
  reviewFeedStreamUrl,
  type FeedFixtureRequest,
} from './feed-fixtures';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { dialogueApi } from './dialogue-fixtures';
import { createOwnedAgentsReviewApi } from './ReviewOwnedAgents';

const ownedAgentsReviewApi = createOwnedAgentsReviewApi('normal');
const nativeSettingsApi = { ...nativeSettingsReviewApi, ...ownedAgentsReviewApi };
const entryShellMutationLog: ReviewCardMutation[] = [];
const entryShellFeedRequests: FeedFixtureRequest[] = [];
const pendingFeedPageReleases: Array<() => void> = [];
const pageErrorAttemptByCursor = new Map<string, number>();

function isFeedWindowEnabled(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('feedWindow') === '1';
}

async function getEntryShellFeedPage(cursor: string): Promise<FeedPage> {
  entryShellFeedRequests.push({ type: 'getFeedPage', cursor });
  if (currentFeedFixtureState() === 'pageLoading') {
    await new Promise<void>((resolve) => pendingFeedPageReleases.push(resolve));
  }
  if (currentFeedFixtureState() === 'pageError') {
    const attempts = (pageErrorAttemptByCursor.get(cursor) ?? 0) + 1;
    pageErrorAttemptByCursor.set(cursor, attempts);
    if (attempts === 1) throw new Error('공개 예시: 다음 쪽을 불러오지 못했습니다.');
  }
  return feedFixturePage(cursor);
}

export const cardChecksCardId = 'public-card-checks';
export const cardChecksSessionId = 'public-shell-session-0';

// Metro selects this only in component-review. Actual entry shells keep their
// production components and receive public data at the transport boundary.
const api = {
  ...createReviewApi('normal', { home: true }),
  getCatalog: async () => ({ folders, sessions: {}, sessionList: [], total: 0 }),
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: () => '', nodeStreamUrl: () => '',
};
const entryShellReviewApi = createReviewApi('normal', { home: true, entryShell: true,
    directCardTouch: typeof window !== 'undefined' && new URLSearchParams(window.location?.search ?? '').get('cardTouch') === 'direct',
    onCardMutation: (mutation) => entryShellMutationLog.push(mutation) });
const entryShellApi = {
  ...entryShellReviewApi,
  getCatalog: async (query?: { folder_id?: string; limit?: number; offset?: number }) => {
    entryShellFeedRequests.push({ type: 'getCatalog' });
    if (!query?.folder_id && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('section') === 'entryShell') {
      throw new Error('피드의 최초 자료는 catalog REST가 아니라 stream session_list로 제공됩니다.');
    }
    return {
      folders: entryShellFolders,
      sessions: {},
      sessionList: entryShellSessions,
      total: entryShellSessions.length,
    };
  },
  getFeedPage: getEntryShellFeedPage,
  getSessionsByIds: async (sessionIds: readonly string[]) => {
    if (!isFeedWindowEnabled()) return entryShellReviewApi.getSessionsByIds(sessionIds);
    entryShellFeedRequests.push({ type: 'getSessionsByIds', sessionIds: [...sessionIds] });
    return feedFixtureSessionLookup(sessionIds);
  },
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: reviewFeedStreamUrl, nodeStreamUrl: () => '',
};

function createCardChecksReviewApi(): ApiClient {
  const location = typeof window === 'undefined' ? undefined : window.location;
  const params = new URLSearchParams(location?.search ?? '');
  const scenario = params.get('state') ?? 'normal';
  const legacy = scenario === 'legacy';
  const currentAt = '2026-10-05T01:00:00Z';
  const currentNow = legacy ? undefined : {
    text: '상황판 위에서 이번 작업의 현재 진행을 확인합니다.',
    turn: (params.get('turn') === 'outside' ? 'outside' : params.get('turn') === 'agent' ? 'agent' : 'user') as 'user' | 'agent' | 'outside',
    ask: params.get('turn') === 'agent' ? null : '확인 항목과 지난 상황을 살펴봐 주세요.',
    updatedAt: currentAt,
    sessionId: cardChecksSessionId,
  };
  const itemAsset = Asset.fromModule(require('../../assets/icon.png')).uri;
  const itemImage = location?.origin
    ? new URL(itemAsset, location.origin).href
    : itemAsset;
  const itemState = (id: number): CardCheckItem => {
    const confirmedAll = scenario === 'all-confirmed' && id !== 7;
    const fields: Record<number, Partial<CardCheckItem>> = {
      1: { state: 'todo', result: null, display: 'todo' },
      2: { state: 'doing', result: '현재 처리 중인 항목입니다.', display: 'doing' },
      3: { state: 'done', result: '요청한 동작을 구현했습니다.', display: 'reported', reportedAt: currentAt },
      4: { state: 'done', result: '수정 뒤 다시 확인할 결과입니다.', display: 'changed', reopened: '화면에서 한 번 더 확인해 주세요.', reportedAt: currentAt, from: { commentId: 'public-spoken', kind: 'spoken', at: '2026-10-04T21:47:00Z' } },
      5: { state: 'done', result: '커멘트에서 요청한 부분을 고칩니다.', display: 'fix', fixOpen: 2, from: { commentId: 'public-source-comment', kind: 'comment', at: currentAt } },
      6: { state: 'done', result: '시안과 같은 화면을 확인했습니다.', display: 'confirmed', confirmed: { at: currentAt, rev: 1 } },
      7: { state: 'dropped', result: '이번 공개 예시에서는 제외한 항목입니다.', display: 'dropped' },
    };
    const base: CardCheckItem = {
      id,
      title: ['목록에서 확인할 항목', '진행 중인 화면을 확인합니다', '결과가 보고된 화면', '다시 확인할 화면', '수정 요청을 반영한 화면', '확인 완료한 항목', '제외한 항목'][id - 1],
      state: 'todo', result: null, evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0,
      reopened: null, from: null, createdAt: '2026-10-04T20:00:00Z', reportedAt: null, display: 'todo',
      ...fields[id],
    };
    if (id === 3) base.evidence = [
      { type: 'image', url: itemImage, label: '화면 캡처 공개 예시' },
      { type: 'link', url: 'https://example.com/card-check-item', label: '참고 링크 공개 예시' },
    ];
    if (id === 4) base.caveat = '실제 iOS 화면은 별도 확인이 필요합니다.';
    if (confirmedAll) {
      base.confirmed = { at: currentAt, rev: base.rev };
      base.display = 'confirmed';
    }
    return base;
  };
  let card: CardDto = {
    ...makeCard('review'),
    id: cardChecksCardId,
    title: '확인 항목과 상황판이 있는 카드',
    request: '실제 앱 진입 경로에서 목록과 카드 상세를 확인합니다.',
    brief: '검수 화면에서 실제 카드 상세에 들어옵니다.\n목록, 상황판, 확인 항목, 커멘트, 세션, 노트를 같은 흐름으로 확인합니다.',
    assigneeKind: 'session', assigneeSessionId: cardChecksSessionId, assigneeAgentId: 'public-agent',
    nodeId: null,
    ...(legacy ? {} : { items: Array.from({ length: 7 }, (_, index) => itemState(index + 1)), now: currentNow }),
  };
  if (scenario === 'all-confirmed' && card.items) {
    card = { ...card, items: card.items.map((item) => item.display === 'dropped' ? item : { ...item, confirmed: { at: currentAt, rev: item.rev }, display: 'confirmed' }) };
  }
  const report = { id: 'public-check-report', cardId: card.id, title: '완료한 결과', format: 'markdown' as const,
    body: '결과와 화면을 확인했습니다.\n\n요청한 동작이 반영됐습니다.', sessionId: cardChecksSessionId, createdAt: '2026-10-04T23:00:00Z' };
  const comments: CardComment[] = [
    { id: 'public-source-comment', cardId: card.id, authorKind: 'user', authorId: 'public-user', sessionId: null, kind: 'comment', itemId: 5, body: '이 항목의 결과를 확인해 주세요.', createdAt: '2026-10-04T21:00:00Z' },
    { id: 'public-agent-comment', cardId: card.id, authorKind: 'agent', authorId: 'public-agent', sessionId: cardChecksSessionId, kind: 'comment', itemId: 3, body: '현재 구현 결과를 공유합니다.', createdAt: '2026-10-04T22:00:00Z' },
  ];
  const questions = [
    { id: 'public-answered-question', cardId: card.id, sessionId: cardChecksSessionId, text: '기존 질문입니다.', options: ['예', '아니요'], answer: '예', askedAt: '2026-10-04T20:30:00Z', answeredAt: '2026-10-04T20:45:00Z' },
    { id: 'public-open-question', cardId: card.id, sessionId: cardChecksSessionId, text: '아직 답을 보내지 않은 질문입니다.', options: ['확인했습니다'], answer: null, askedAt: '2026-10-04T22:30:00Z' },
  ];
  const notes = Array.from({ length: 15 }, (_, index) => ({
    id: `public-note-${index + 1}`, cardId: card.id, authorKind: 'agent' as const, authorId: 'public-agent',
    sessionId: cardChecksSessionId, kind: 'note' as const, body: `인계 노트 ${index + 1}의 공개 예시입니다.`,
    createdAt: new Date(Date.parse('2026-10-04T10:00:00Z') + index * 60_000).toISOString(),
  }));
  const nowHistory = currentNow ? [
    { text: '처음 확인을 시작했습니다.', turn: 'agent' as const, ask: null, at: '2026-10-04T20:00:00Z' },
    { text: '이전 결과를 살펴봐 주세요.', turn: 'user' as const, ask: '결과를 확인해 주세요.', at: '2026-10-04T22:00:00Z' },
    { text: currentNow.text, turn: currentNow.turn, ask: currentNow.ask, at: currentAt },
  ] : [];
  const detail = (): CardDetail => ({
    card: { ...card }, reports: [report], comments: comments.map((comment) => ({ ...comment })),
    questions, sessions: entryShellSessions.slice(0, 7), notes: legacy ? undefined : notes,
    nowHistory: legacy ? undefined : nowHistory,
  });
  const base = entryShellApi;
  const record = (kind: string, data: unknown) => {
    if (typeof window === 'undefined') return;
    const host = window as Window & { __cardChecksRequests?: Array<{ kind: string; data: unknown }> };
    host.__cardChecksRequests ??= [];
    host.__cardChecksRequests.push({ kind, data });
  };
  return {
    ...base,
    getPersistentSession: async (sessionId: string) => {
      const session = entryShellSessions.find((entry) => entry.agentSessionId === sessionId);
      if (!session) throw new Error('공개 예시 세션을 찾을 수 없습니다.');
      return { session: {
        session_id: sessionId, display_name: session.displayName ?? null,
        node_id: session.nodeId ?? null, folder_id: session.folderId ?? null, agent_id: session.agentId ?? null,
        persistent: false, settings: { default_model: { model_preset: session.modelPreset ?? null, reasoning_effort: null } },
        runtime: { current_model: { model_preset: session.modelPreset ?? null, reasoning_effort: null, model: null }, pending: null },
      } };
    },

    listCards: async (folderId?: string) => ({ cards: folderId && folderId !== card.folderId ? [] : [{ ...card }] }),
    listCompletedCards: async () => ({ cards: [], nextCursor: null }),
    getCard: async (id: string) => {
      if (id !== card.id) return base.getCard(id);
      record('getCard', { id });
      return detail();
    },
    setCardStatus: async (id: string, status: CardStatus): Promise<CardMutationResult> => {
      if (id !== card.id) return base.setCardStatus(id, status, card.version, `review-status-${id}`);
      record('status', { id, status });
      card = { ...card, status, version: card.version + 1 };
      return { folderId: card.folderId, card: { ...card } };
    },
    confirmCardItem: async (id: string, itemId: number, confirmed: boolean): Promise<CardMutationResult> => {
      record('confirm', { id, itemId, confirmed });
      if (scenario === 'fail-confirm') throw new Error('공개 예시: 확인을 저장하지 못했습니다.');
      const item = card.items?.find((entry) => entry.id === itemId);
      if (!item || item.display === 'dropped') throw new Error('알 수 없는 공개 예시 확인 항목');
      const next: CardCheckItem = confirmed
        ? { ...item, confirmed: { at: new Date().toISOString(), rev: item.rev }, reopened: null, fixOpen: 0, display: 'confirmed' }
        : { ...item, confirmed: null, display: item.state === 'doing' ? 'doing' : item.reopened ? 'changed' : item.state === 'done' ? 'reported' : 'todo' };
      card = { ...card, version: card.version + 1, items: card.items!.map((entry) => entry.id === itemId ? next : entry) };
      return { folderId: card.folderId, card: { ...card } };
    },
    addCardComment: async (id: string, input: { body: string; itemId?: number; idempotencyKey: string }): Promise<CardComment> => {
      record('comment', { id, ...input });
      if (scenario === 'fail-comment') throw new Error('공개 예시: 커멘트를 저장하지 못했습니다.');
      const saved: CardComment = { id: input.idempotencyKey, cardId: id, authorKind: 'user', authorId: 'public-user',
        sessionId: null, kind: 'comment', ...(input.itemId === undefined ? {} : { itemId: input.itemId }), body: input.body, createdAt: new Date().toISOString() };
      comments.push(saved);
      if (input.itemId !== undefined && card.items) {
        card = { ...card, version: card.version + 1, items: card.items.map((item) => item.id === input.itemId
          ? { ...item, confirmed: null, fixOpen: item.fixOpen + 1, display: 'fix' }
          : item) };
      }
      return saved;
    },
  } as unknown as ApiClient;
}

const cardChecksApi = createCardChecksReviewApi();

export const ENTRY_SHELL_ALERT_EVENT = 'soul-app-review-entry-shell-alert';
export type EntryShellAlertRequest = { title?: string; message?: string; buttons?: AlertButton[] };

/** RNWeb has no OS Alert UI, so entryShell supplies an explicit public harness substitute. */
export function installEntryShellPublicHarness() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  const previousAlert = Alert.alert;
  const reviewWindow = window as Window & {
    __soulAppEntryShellCardMutations?: ReviewCardMutation[];
    __soulAppFeedFixture?: { requests: FeedFixtureRequest[]; releaseNextPage: () => void };
  };
  entryShellMutationLog.length = 0;
  entryShellFeedRequests.length = 0;
  pendingFeedPageReleases.length = 0;
  pageErrorAttemptByCursor.clear();
  reviewWindow.__soulAppEntryShellCardMutations = entryShellMutationLog;
  reviewWindow.__soulAppFeedFixture = {
    requests: entryShellFeedRequests,
    releaseNextPage: () => pendingFeedPageReleases.shift()?.(),
  };
  Alert.alert = ((title?: string, message?: string, buttons?: AlertButton[]) => {
    window.dispatchEvent(new CustomEvent<EntryShellAlertRequest>(ENTRY_SHELL_ALERT_EVENT, {
      detail: { title, message, buttons },
    }));
  }) as typeof Alert.alert;
  return () => {
    Alert.alert = previousAlert;
    delete reviewWindow.__soulAppEntryShellCardMutations;
    delete reviewWindow.__soulAppFeedFixture;
  };
}

export type CardColorReviewMode = 'success' | 'pending' | 'error';

export function createCardColorReviewClient(mode: CardColorReviewMode = 'success') {
  let card: CardDto = { ...makeCard('todo'), id: 'public-card-color', color: 'blue' };
  let reads = 0;
  const calls: Array<{ id: string; patch: CardPatch; expectedVersion: number; idempotencyKey: string }> = [];
  const base = createReviewApi('normal', { home: true });
  const reviewApi = {
    ...base,
    getCard: async (id: string) => {
      if (id !== card.id) return base.getCard(id);
      reads += 1;
      return { card: { ...card }, reports: [], comments: [], questions: [], sessions: [] };
    },
    updateCard: async (id: string, patch: CardPatch, expectedVersion: number, idempotencyKey: string): Promise<CardMutationResult> => {
      calls.push({ id, patch: { ...patch }, expectedVersion, idempotencyKey });
      if (id !== card.id) throw new Error('알 수 없는 색상 공개 예시 카드');
      if (!patch.color || !idempotencyKey) throw new Error('색상과 idempotencyKey가 필요합니다.');
      if (mode === 'pending') return new Promise<CardMutationResult>(() => {});
      if (mode === 'error') throw new Error('공개 예시: 색상을 저장하지 못했습니다.');
      if (expectedVersion !== card.version) throw new Error('공개 예시: 버전 충돌');
      card = { ...card, ...patch, version: card.version + 1 };
      return { folderId: card.folderId, card: { ...card } };
    },
  };
  return {
    api: reviewApi as unknown as ApiClient,
    get card() { return { ...card }; },
    calls,
    get readCount() { return reads; },
  };
}
export function createApiClient(): ApiClient {
  const section = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('section') : null;
  if (section === 'cardChecks') return cardChecksApi;
  if (section === 'folderTabs') {
    const empty = new URLSearchParams(window.location.search).get('state') === 'empty';
    return { ...api, getCatalog: async () => ({ folders: empty ? [] : folderTabReviewFolders, sessions: {}, sessionList: [], total: 0 }),
      getStarredFolders: async () => ({ items: empty ? [] : starredFolders, nextCursor: null }) } as unknown as ApiClient;
  }
  if (section === 'cardColors') return createCardColorReviewClient().api;
  if (section === 'nativeSettings') return nativeSettingsApi;
  if (section === 'entryShell') return entryShellApi as unknown as ApiClient;
  if (section === 'dialogues') return dialogueApi;
  return api as unknown as ApiClient;
}
