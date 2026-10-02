import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import { subscribeAuthScope } from '../lib/auth-scope';
import { withDiagnosticStateStorage } from './diagnosticStateStorage';

export type SearchScope = 'all' | 'sessions' | 'messages';
export type SearchPeriod = 'today' | '7d' | '30d' | 'all';
export type SearchEventCategory =
  | 'messages'
  | 'responses'
  | 'thinking';

export interface SearchFilters {
  folderId: string | null;
  nodeId: string | null;
  statuses: string[];
  backends: string[];
  period: SearchPeriod;
  eventCategories: SearchEventCategory[];
  includeTurnSummaries: boolean;
  includeHighlight: boolean;
  includeStory: boolean;
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  folderId: null,
  nodeId: null,
  statuses: [],
  backends: [],
  period: 'all',
  eventCategories: ['messages', 'responses'],
  includeTurnSummaries: false,
  includeHighlight: false,
  includeStory: false,
};

const SEARCH_STORE_VERSION = 2;
const HUMAN_SEARCH_EVENT_CATEGORIES = [
  'messages',
  'responses',
  'thinking',
] as const satisfies readonly SearchEventCategory[];

interface SearchState {
  query: string;
  scope: SearchScope;
  filters: SearchFilters;
  recentQueries: string[];
  recentSessionIds: string[];
  tabletActive: boolean;
  focusRequestId: number;
  activationRequestId: number;
  selectedResultIndex: number;
  resultCount: number;
  setQuery(query: string): void;
  setScope(scope: SearchScope): void;
  setFilters(filters: Partial<SearchFilters>): void;
  resetFilters(): void;
  rememberQuery(query: string): void;
  clearRecentQueries(): void;
  rememberSession(sessionId: string): void;
  openTabletSearch(): void;
  closeTabletSearch(): void;
  requestSearchFocus(): void;
  requestActivateSelection(): void;
  setSelectedResultIndex(index: number): void;
  setResultCount(count: number): void;
  reset(): void;
}

const secureStorage = withDiagnosticStateStorage({
  getItem: (name: string) => SecureStore.getItemAsync(name),
  setItem: (name: string, value: string) => SecureStore.setItemAsync(name, value),
  removeItem: (name: string) => SecureStore.deleteItemAsync(name),
}, 'search');

const runtimeInitial = {
  query: '',
  tabletActive: false,
  focusRequestId: 0,
  activationRequestId: 0,
  selectedResultIndex: 0,
  resultCount: 0,
};

export function migrateSearchPersistedState(
  persistedState: unknown,
): Record<string, unknown> {
  const persisted = isRecord(persistedState) ? persistedState : {};
  const persistedFilters = isRecord(persisted.filters)
    ? persisted.filters
    : {};
  return {
    ...persisted,
    filters: {
      ...DEFAULT_SEARCH_FILTERS,
      ...persistedFilters,
      eventCategories: normalizeHumanSearchEventCategories(
        persistedFilters.eventCategories,
      ),
      includeTurnSummaries: persistedFilters.includeTurnSummaries === true,
      includeHighlight: persistedFilters.includeHighlight === true,
      includeStory: persistedFilters.includeStory === true,
    },
  };
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      ...runtimeInitial,
      scope: 'all',
      filters: { ...DEFAULT_SEARCH_FILTERS },
      recentQueries: [],
      recentSessionIds: [],
      setQuery: (query) => set({ query, selectedResultIndex: 0 }),
      setScope: (scope) => set({ scope, selectedResultIndex: 0 }),
      setFilters: (filters) => set((state) => ({
        filters: { ...state.filters, ...filters },
        selectedResultIndex: 0,
      })),
      resetFilters: () => set({
        filters: { ...DEFAULT_SEARCH_FILTERS },
        selectedResultIndex: 0,
      }),
      rememberQuery: (query) => set((state) => {
        const normalized = query.trim();
        if (!normalized) return state;
        return {
          recentQueries: moveToFront(state.recentQueries, normalized, 8),
        };
      }),
      clearRecentQueries: () => set({ recentQueries: [] }),
      rememberSession: (sessionId) => set((state) => ({
        recentSessionIds: moveToFront(state.recentSessionIds, sessionId, 5),
      })),
      openTabletSearch: () => set({ tabletActive: true }),
      closeTabletSearch: () => set({
        tabletActive: false,
        query: '',
        selectedResultIndex: 0,
      }),
      requestSearchFocus: () => set((state) => ({
        tabletActive: true,
        focusRequestId: state.focusRequestId + 1,
      })),
      requestActivateSelection: () => set((state) => ({
        activationRequestId: state.activationRequestId + 1,
      })),
      setSelectedResultIndex: (selectedResultIndex) => set({ selectedResultIndex }),
      setResultCount: (resultCount) => set({ resultCount }),
      reset: () => set({
        ...runtimeInitial,
        scope: 'all',
        filters: { ...DEFAULT_SEARCH_FILTERS },
        recentQueries: [],
        recentSessionIds: [],
      }),
    }),
    {
      name: 'soul-session-search',
      storage: createJSONStorage(() => secureStorage),
      partialize: (state) => ({
        scope: state.scope,
        filters: state.filters,
        recentQueries: state.recentQueries,
        recentSessionIds: state.recentSessionIds,
      }),
      version: SEARCH_STORE_VERSION,
      migrate: (persistedState) =>
        migrateSearchPersistedState(persistedState) as unknown as SearchState,
    },
  ),
);

subscribeAuthScope(() => {
  useSearchStore.setState({
    query: '',
    tabletActive: false,
    selectedResultIndex: 0,
  });
});

function moveToFront(values: string[], value: string, limit: number): string[] {
  return [value, ...values.filter((item) => item !== value)].slice(0, limit);
}

function normalizeHumanSearchEventCategories(
  value: unknown,
): SearchEventCategory[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SEARCH_FILTERS.eventCategories];
  }
  const categories = value.filter(
    (item): item is SearchEventCategory =>
      typeof item === 'string'
      && HUMAN_SEARCH_EVENT_CATEGORIES.includes(item as SearchEventCategory),
  );
  const uniqueCategories = [...new Set(categories)];
  return uniqueCategories.length > 0
    ? uniqueCategories
    : [...DEFAULT_SEARCH_FILTERS.eventCategories];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
