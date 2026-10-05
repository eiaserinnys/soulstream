import type { ApiClient } from '../api/client';
import type { FeedPage } from '../api/feedPage';
import { Alert, Platform, type AlertButton } from 'react-native';
import type { CardDto, CardMutationResult, CardPatch } from '../api/cardTypes';
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

// Metro selects this only in component-review. Actual entry shells keep their
// production components and receive public data at the transport boundary.
const api = {
  ...createReviewApi('normal', { home: true }),
  getCatalog: async () => ({ folders, sessions: {}, sessionList: [], total: 0 }),
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: () => '', nodeStreamUrl: () => '',
};
const entryShellApi = {
  ...createReviewApi('normal', { home: true, entryShell: true,
    directCardTouch: typeof window !== 'undefined' && new URLSearchParams(window.location?.search ?? '').get('cardTouch') === 'direct',
    onCardMutation: (mutation) => entryShellMutationLog.push(mutation) }),
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
    entryShellFeedRequests.push({ type: 'getSessionsByIds', sessionIds: [...sessionIds] });
    return feedFixtureSessionLookup(sessionIds);
  },
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: reviewFeedStreamUrl, nodeStreamUrl: () => '',
};

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
