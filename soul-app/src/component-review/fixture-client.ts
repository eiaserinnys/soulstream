import type { ApiClient } from '../api/client';
import { createReviewApi, folders } from './fixtures';
import { dialogueApi } from './dialogue-fixtures';

// Metro selects this only in component-review. Actual entry shells keep their
// production components and receive public data at the transport boundary.
const api = {
  ...createReviewApi('normal', { home: true }),
  getCatalog: async () => ({ folders, sessions: {}, sessionList: [], total: 0 }),
  getSessionsByIds: async () => ({ sessions: [], total: 0 }),
  getDailyHistory: async () => ({ dates: [] }),
  getStarredFolders: async () => ({ items: [], nextCursor: null }),
  catalogStreamUrl: () => '', nodeStreamUrl: () => '',
};
export function createApiClient(): ApiClient {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('section') === 'dialogues'
    ? dialogueApi : api as unknown as ApiClient;
}
