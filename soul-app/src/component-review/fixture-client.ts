import { useSessionStore } from '../store/sessionStore';
import type { ApiClient } from '../api/client';
import { createApiRequestContext } from '../api/clientCore';
import { createUsageEndpoints } from '../api/usageEndpoints';
import type { FeedPage } from '../api/feedPage';
import { Alert, Platform, type AlertButton } from 'react-native';
import type { CardCheckItem, CardComment, CardDetail, CardDto, CardMutationResult, CardPatch, CardStatus } from '../api/cardTypes';
import { buildAttachmentReviewApi } from './attachment-review-api';
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
import { createPersistentFullscreenReviewApi, persistentWeeklyUsageReviewSummary } from './persistent-fullscreen-fixtures';
import { contentLinkReviewSessionEventsUrl } from './chat-fixtures';
import { createChatUiFlowReviewApi } from './chat-ui-flow-client';
import { createPersistentReportReviewApi } from './persistent-report-fixtures';
import { createReviewCardApi } from './ReviewPasCardExpand';

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
  // Ordinary fixture ids yield the existing handled 404/null display projection.
  getPersistentSession: nativeSettingsReviewApi.getPersistentSession,
  getCard: async (cardId: string) => {
    const detail = await entryShellReviewApi.getCard(cardId);
    if (cardId !== 'public-shell-card-owner') return detail;
    return {
      ...detail,
      notes: [{
        id: 'public-content-link-note', cardId, authorKind: 'user', authorId: 'public-user',
        sessionId: null, kind: 'note',
        body: `[문서 노트 열기](${contentLinkOrigin()}/api/markdown-documents/public-content-document)`,
        createdAt: '2026-10-12T00:00:00Z',
      }],
    };
  },
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

export type ContentLinkDocumentState = 'ready' | 'loading' | 'slow' | 'error';
export const contentLinkDocumentId = 'public-content-document';
export const contentLinkRelatedDocumentId = 'a9ed373b-9207-4ed3-9797-59a39af87525';
export const contentLinkReviewDocumentTitle = '#270 계획 갱신 v4 (2026-10-12): 지금 PAS 응답에 맞춘 범위와 순서';

function contentLinkOrigin(): string {
  return typeof window === 'undefined' ? 'https://soulstream.test' : window.location?.origin ?? 'https://soulstream.test';
}

function createContentLinkDocuments(origin: string) {
  const realBody = [
    '# #270 계획 갱신 v4 (2026-10-12)',
    '',
    '지금 PAS는 계획을 세울 때보다 정돈된 글을 냅니다. 카드 번호와 제목으로 시작해 짧은 불렛으로 나누고, 판단이 필요하면 끝에 묻습니다. 그래서 2단계의 핵심이던 "다른 모델이 여러 응답을 다시 써서 하나로 합친다"는 일감은 크게 줄었고, 응답이 여러 개 쌓인다는 문제만 남았습니다. 1단계(채팅에서 조작하는 UI)의 기술 설계는 그대로 쓸 수 있습니다. 다만 PAS의 기본 모델이 바뀌었고 토큰을 아끼는 기조가 생겼으므로, 한꺼번에 만들지 않고 얇은 한 줄을 먼저 완성하는 순서로 바꾸기를 권합니다.',
    '',
    '## 이 문서의 자리',
    '',
    '- 계획의 정본은 이 문서입니다. 범위, 순서, 남은 결정은 여기서 봅니다.',
    '- 아래 문서는 근거 자료로 보존했고 고치지 않았습니다.',
    `  - [누적 응답 뷰 검토 v3](${origin}/api/markdown-documents/${contentLinkRelatedDocumentId}): 2단계의 근거와 원칙`,
    `  - [1단계 기술 명세 v2](${origin}/api/markdown-documents/b1306380-bb56-4ebe-b2ad-613f23c31834): 1단계의 기술 계약`,
    `  - [독립 기술 검증 v1](${origin}/api/markdown-documents/f88d7e92-70e2-4ac4-be80-2e9cbd89287f): 명세의 통과 판정`,
    `  - [디자인 시안 v2](${origin}/api/markdown-documents/0ffcdd1c-f922-47a1-8221-36e48032ff71): 독립 검수 미완료, 미채택`,
    '- "현재 PAS 응답"은 PAS 세션이 10월 8일부터 12일까지 실제로 낸 응답과, 그 응답을 정하는 지속 지시, 주입 구성, 모델 설정으로 읽었습니다. 화면의 표시 규칙은 코드로만 읽었습니다.',
    '- 사용자가 푼 것은 계획 갱신과 보고뿐입니다. 구현, 구현 위임, PR, 머지, 배포, 앱 빌드, 새 시안과 검수 세션은 계속 홀드입니다.',
    `- 검수용으로 더한 줄: [연결 카드](${origin}/?card=public-shell-card-owner)`,
    `- [같은 문서 다시 열기](${origin}/api/markdown-documents/${contentLinkDocumentId})`,
    '',
    '## 바뀐 전제',
    '',
    '| 전제 | 계획 당시 (10/10, 10/11) | 지금 (10/12) | 계획에 주는 영향 |',
    '| --- | --- | --- | --- |',
    '| PAS 글의 모양 | 실질 응답의 41~56%가 불렛, 65~68%가 카드 번호와 제목 포함 | 94%가 불렛, 82%가 카드 번호와 제목 포함 | PAS가 이미 카드 단위로 편집한 글을 냅니다. 별도 편집 모델이 할 일이 줄었습니다 |',
    '| 응답 하나의 길이 | 중앙값 106~109자 | 중앙값 181자 | 글 하나가 길어지고 개수는 줄었습니다 |',
    '| 응답이 쌓이는 정도 | 사람 발화 사이에 평균 5.4~10.1개, 상위 10%는 16~23개 | 평균 4.1개, 상위 10%는 8개 | 줄었지만 여전히 쌓입니다. 누적을 다룰 필요는 남아 있습니다 |',
    '| 판단 요청 | 실질 응답 300건 중 3건 | 33건 중 14건 | UI가 가장 쓸모 있는 자리가 드러났습니다 |',
    '| PAS의 모델 | Sol 6.1 high | 기본 Sonnet medium, 한도 때 Sol 6.1 high | 모델이 큰 구조 문서를 직접 쓰는 전제입니다 |',
    '| 코드 | main 49cdd4c5 | main 92285dee | 명세의 코드 근거는 유효합니다 |',
    '',
    '## 유지할 것',
    '',
    '- 두 단계 분리. 1단계는 채팅에서 조작하는 UI의 공통 기반, 2단계는 PAS 누적 뷰입니다.',
    '- 1단계의 기술 구조. 에이전트가 완성된 구조 문서를 도구로 발행하고, 기존 저장과 전송 경로로 보내며, 웹과 앱이 같은 계산 규칙으로 그립니다.',
    '',
    '## 갱신한 순서',
    '',
    '### 1단계: 채팅에서 조작하는 UI',
    '',
    '1. 공통 계약과 도구, 저장을 만듭니다. 도구는 화면이 준비된 구성 요소만 받습니다. 끝나면 가장 먼저 PAS의 두 모델이 실제로 발행하는지 봅니다.',
    '2. 앱의 읽는 쪽 수정(화면이 없는 부분)을 먼저 main에 머지합니다.',
    '3. 웹 화면(PAS와 일반 채팅)과 입력창 연결을 만들어 운영에 배포합니다.',
    '',
    '### 2단계: PAS 누적 뷰',
    '',
    '- A. 모델 없는 접기. 실제 PAS 화면에서 한 실행이 끝나면 그 실행의 진행 안내 줄을 최종 답 아래로 접습니다.',
    '- B. PAS가 직접 갱신하는 현황. PAS가 카드별 현황을 다시 발행하면 이전 것이 접히게 합니다.',
  ].join('\n');
  const relatedBody = [
    '# #270 누적 응답 뷰 검토 v3',
    '',
    '2단계의 근거와 원칙을 적은 문서입니다. 원문 보존, 실제 PAS 화면에만 적용, 일반 채팅과 카드 화면 무변경을 원칙으로 둡니다.',
    '',
    `- 계획의 정본은 [계획 갱신 v4](${origin}/api/markdown-documents/${contentLinkDocumentId})입니다.`,
  ].join('\n');
  return {
    [contentLinkDocumentId]: {
      id: contentLinkDocumentId, title: contentLinkReviewDocumentTitle, body: realBody, version: 1,
    },
    [contentLinkRelatedDocumentId]: {
      id: contentLinkRelatedDocumentId, title: '#270 누적 응답 뷰 검토 v3', body: relatedBody, version: 1,
    },
  };
}

export const contentLinkReviewDocument = createContentLinkDocuments(contentLinkOrigin())[contentLinkDocumentId];

export function createContentLinkReviewApi(state: ContentLinkDocumentState = 'ready'): ApiClient {
  const origin = typeof window === 'undefined' ? 'https://soulstream.test'
    : window.location?.origin ?? 'https://soulstream.test';
  return {
    ...entryShellApi,
    sessionEventsUrl: (sessionId: string, lastEventId?: string) =>
      contentLinkReviewSessionEventsUrl(sessionId, lastEventId, origin),
    getMarkdownDocument: async (documentId: string) => {
      const document = createContentLinkDocuments(origin)[documentId as keyof ReturnType<typeof createContentLinkDocuments>];
      if (!document) throw new Error('공개 예시: 문서를 찾지 못했습니다.');
      if (state === 'loading') return new Promise(() => {});
      if (state === 'error') throw new Error('공개 예시: 문서를 불러오지 못했습니다.');
      if (state === 'slow') await new Promise((resolve) => setTimeout(resolve, 2500));
      return document;
    },
  } as unknown as ApiClient;
}

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
    { id: 'public-withdrawn-question', cardId: card.id, sessionId: cardChecksSessionId, text: '어느 안으로 할까요?', options: ['A안', 'B안'], answer: null,
      askedAt: '2026-10-04T22:45:00Z', withdrawnAt: '2026-10-04T22:50:00Z', withdrawalReason: '커멘트에서 B안으로 정해져 거둡니다' },
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
export function createApiClient(baseUrl = ''): ApiClient {
  const section = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('section') : null;
  const usageEndpoints = createUsageEndpoints(createApiRequestContext(baseUrl));
  if (section === 'attachments' || section === 'cardImages') return createAttachmentReviewApi();
  if (section === 'chatUiRenderer') return createChatUiFlowReviewApi(window.location.search);
  if (section === 'contentLinks' || section === 'contentLinkDocument') {
    const value = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('documentState');
    const state = value === 'loading' || value === 'slow' || value === 'error' ? value : 'ready';
    return createContentLinkReviewApi(state);
  }
  if (section === 'cardChecks') return cardChecksApi;
  if (section === 'folderTabs') {
    const empty = new URLSearchParams(window.location.search).get('state') === 'empty';
    return { ...api, getCatalog: async () => ({ folders: empty ? [] : folderTabReviewFolders, sessions: {}, sessionList: [], total: 0 }),
      getStarredFolders: async () => ({ items: empty ? [] : starredFolders, nextCursor: null }) } as unknown as ApiClient;
  }
  if (section === 'cardColors') return createCardColorReviewClient().api;
  if (section === 'iphoneDuo') {
    const api = {
      ...entryShellApi,
      ...nativeSettingsApi,
      getCard: entryShellApi.getCard,
      listCards: entryShellApi.listCards,
      listCompletedCards: entryShellApi.listCompletedCards,
      getCatalog: entryShellApi.getCatalog,
      getFeedPage: entryShellApi.getFeedPage,
      getSessionsByIds: entryShellApi.getSessionsByIds,
      catalogStreamUrl: entryShellApi.catalogStreamUrl,
    };
    return new URLSearchParams(window.location.search).get('sample') === 'pas-layout'
      ? { ...api, ...createReviewCardApi(),
        dismissPersistentReport: async (sessionId: string, key: string) => {
          const entries = useSessionStore.getState().persistentReportsBySession[sessionId]?.entries ?? [];
          const remaining = entries.filter(entry => entry.key !== key);
          useSessionStore.getState().applyPersistentReport(sessionId, remaining);
          return { ok: true as const, changed: remaining.length !== entries.length, entries: remaining.map(({ key, title }) => ({ key, title })), persistent_report: remaining };
        },
        getUsageSummary: async () => ({
        ...persistentWeeklyUsageReviewSummary,
        nodes: persistentWeeklyUsageReviewSummary.nodes.map((node, index) => index === 0 ? { ...node, nodeId: 'public-node' } : node),
      }) } as unknown as ApiClient
      : api as unknown as ApiClient;
  }
  if (section === 'nativeSettings') return { ...nativeSettingsApi, ...usageEndpoints } as unknown as ApiClient;
  if (section === 'persistent') {
    const api = createPersistentFullscreenReviewApi(window.location.search);
    return new URLSearchParams(window.location.search).get('sample') === 'report'
      ? createPersistentReportReviewApi(api, window.location.search) : api;
  }
  if (section === 'dialogues' && new URLSearchParams(window.location.search).get('sample') === 'persistent-select') return nativeSettingsApi;
  if (section === 'entryShell') return entryShellApi as unknown as ApiClient;
  if (section === 'dialogues') return dialogueApi;
  return { ...api, ...usageEndpoints } as unknown as ApiClient;
}

export function createAttachmentReviewApi(): ApiClient {
  return buildAttachmentReviewApi(api);
}
