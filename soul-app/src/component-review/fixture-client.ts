import type { ApiClient } from '../api/client';
import { Alert, Platform, type AlertButton } from 'react-native';
import type { CardDto, CardMutationResult, CardPatch } from '../api/cardTypes';
import {
  createReviewApi,
  entryShellCatalogSessions,
  entryShellFolders,
  entryShellSessions,
  folderTabReviewFolders,
  folders,
  makeCard,
  starredFolders,
  type ReviewCardMutation,
} from './fixtures';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { dialogueApi } from './dialogue-fixtures';
import { createOwnedAgentsReviewApi } from './ReviewOwnedAgents';

const ownedAgentsReviewApi = createOwnedAgentsReviewApi('normal');
const nativeSettingsApi = { ...nativeSettingsReviewApi, ...ownedAgentsReviewApi };
const entryShellMutationLog: ReviewCardMutation[] = [];

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
  ...createReviewApi('normal', { home: true, entryShell: true, onCardMutation: (mutation) => entryShellMutationLog.push(mutation) }),
  getCatalog: async () => ({
    folders: entryShellFolders,
    sessions: entryShellCatalogSessions,
    sessionList: entryShellSessions,
    total: entryShellSessions.length,
  }),
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: () => '', nodeStreamUrl: () => '',
};

export const ENTRY_SHELL_ALERT_EVENT = 'soul-app-review-entry-shell-alert';
export type EntryShellAlertRequest = { title?: string; message?: string; buttons?: AlertButton[] };

/** RNWeb has no OS Alert UI, so entryShell supplies an explicit public harness substitute. */
export function installEntryShellPublicHarness() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  const previousAlert = Alert.alert;
  const reviewWindow = window as Window & { __soulAppEntryShellCardMutations?: ReviewCardMutation[] };
  entryShellMutationLog.length = 0;
  reviewWindow.__soulAppEntryShellCardMutations = entryShellMutationLog;
  Alert.alert = ((title?: string, message?: string, buttons?: AlertButton[]) => {
    window.dispatchEvent(new CustomEvent<EntryShellAlertRequest>(ENTRY_SHELL_ALERT_EVENT, {
      detail: { title, message, buttons },
    }));
  }) as typeof Alert.alert;
  return () => {
    Alert.alert = previousAlert;
    delete reviewWindow.__soulAppEntryShellCardMutations;
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
