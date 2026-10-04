import type { ApiClient } from '../api/client';
import { createReviewApi, folders, starredFolders, folderTabReviewFolders } from './fixtures';
import { dialogueApi } from './dialogue-fixtures';

// Metro selects this only in component-review. Actual entry shells keep their
// production components and receive public data at the transport boundary.
const api = {
  ...createReviewApi('normal', { home: true }),
  getCatalog: async () => ({ folders, sessions: {}, sessionList: [], total: 0 }),
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: () => '', nodeStreamUrl: () => '',
};
export function createApiClient(): ApiClient {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('section') === 'folderTabs') {
    const empty = new URLSearchParams(window.location.search).get('state') === 'empty';
    return { ...api, getCatalog: async () => ({ folders: empty ? [] : folderTabReviewFolders, sessions: {}, sessionList: [], total: 0 }),
      getStarredFolders: async () => ({ items: empty ? [] : starredFolders, nextCursor: null }) } as unknown as ApiClient;
  }
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('section') === 'dialogues'
    ? dialogueApi : api as unknown as ApiClient;
}
