import type { ApiClient } from '../api/client';
import {
  createReviewApi,
  entryShellCatalogSessions,
  entryShellFolders,
  entryShellSessions,
  folderTabReviewFolders,
  folders,
  starredFolders,
} from './fixtures';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { dialogueApi } from './dialogue-fixtures';
import { createOwnedAgentsReviewApi } from './ReviewOwnedAgents';

const ownedAgentsReviewApi = createOwnedAgentsReviewApi('normal');
const nativeSettingsApi = { ...nativeSettingsReviewApi, ...ownedAgentsReviewApi };

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
  ...createReviewApi('normal', { home: true, entryShell: true }),
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
export function createApiClient(): ApiClient {
  const section = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('section') : null;
  if (section === 'folderTabs') {
    const empty = new URLSearchParams(window.location.search).get('state') === 'empty';
    return { ...api, getCatalog: async () => ({ folders: empty ? [] : folderTabReviewFolders, sessions: {}, sessionList: [], total: 0 }),
      getStarredFolders: async () => ({ items: empty ? [] : starredFolders, nextCursor: null }) } as unknown as ApiClient;
  }
  if (section === 'nativeSettings') return nativeSettingsApi;
  if (section === 'entryShell') return entryShellApi as unknown as ApiClient;
  if (section === 'dialogues') return dialogueApi;
  return api as unknown as ApiClient;
}
