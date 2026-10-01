import * as SecureStore from 'expo-secure-store';
import {
  DEFAULT_SEARCH_FILTERS,
  migrateSearchPersistedState,
  useSearchStore,
} from '../searchStore';

beforeEach(() => {
  useSearchStore.getState().reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('기본 메시지 검색은 사용자·에이전트 응답만 포함하고 도구는 제외한다', () => {
  expect(DEFAULT_SEARCH_FILTERS.eventCategories).toEqual([
    'messages',
    'responses',
  ]);
  expect(DEFAULT_SEARCH_FILTERS).toMatchObject({
    includeTurnSummaries: false,
    includeHighlight: false,
    includeStory: false,
  });
});

test('최근 검색과 최근 본 세션은 중복을 앞으로 옮기고 상한을 지킨다', () => {
  for (let index = 0; index < 10; index += 1) {
    useSearchStore.getState().rememberQuery(`query-${index}`);
    useSearchStore.getState().rememberSession(`session-${index}`);
  }
  useSearchStore.getState().rememberQuery('query-7');
  useSearchStore.getState().rememberSession('session-7');

  expect(useSearchStore.getState().recentQueries).toEqual([
    'query-7',
    'query-9',
    'query-8',
    'query-6',
    'query-5',
    'query-4',
    'query-3',
    'query-2',
  ]);
  expect(useSearchStore.getState().recentSessionIds).toEqual([
    'session-7',
    'session-9',
    'session-8',
    'session-6',
    'session-5',
  ]);
});

test('저장 스코프와 전체 필터를 한 정본에서 갱신·초기화한다', () => {
  useSearchStore.getState().setScope('messages');
  useSearchStore.getState().setFilters({
    folderId: 'folder-a',
    nodeId: 'node-a',
    statuses: ['completed'],
    backends: ['codex'],
    period: '7d',
    eventCategories: ['responses', 'thinking'],
    includeTurnSummaries: true,
    includeHighlight: true,
    includeStory: true,
  });

  expect(useSearchStore.getState()).toMatchObject({
    scope: 'messages',
    filters: {
      folderId: 'folder-a',
      nodeId: 'node-a',
      statuses: ['completed'],
      backends: ['codex'],
      period: '7d',
      eventCategories: ['responses', 'thinking'],
      includeTurnSummaries: true,
      includeHighlight: true,
      includeStory: true,
    },
  });

  useSearchStore.getState().resetFilters();
  expect(useSearchStore.getState().filters).toEqual(DEFAULT_SEARCH_FILTERS);
});

test('옛 persisted 필터에서 tools와 비허용 값을 제거하고 남은 사람용 필터를 보존한다', () => {
  const migrated = migrateSearchPersistedState({
    scope: 'messages',
    filters: {
      ...DEFAULT_SEARCH_FILTERS,
      eventCategories: ['tools', 'thinking', 'future-category'],
    },
  }) as {
    filters: { eventCategories: string[] };
  };

  expect(migrated.filters.eventCategories).toEqual(['thinking']);
});

test('옛 persisted 필터에 없던 포함 범위는 모두 꺼진 상태로 이관한다', () => {
  const migrated = migrateSearchPersistedState({
    scope: 'messages',
    filters: {
      folderId: null,
      nodeId: null,
      statuses: [],
      backends: [],
      period: 'all',
      eventCategories: ['messages', 'responses'],
    },
  }) as {
    filters: {
      includeTurnSummaries: boolean;
      includeHighlight: boolean;
      includeStory: boolean;
    };
  };

  expect(migrated.filters).toMatchObject({
    includeTurnSummaries: false,
    includeHighlight: false,
    includeStory: false,
  });
});

test('옛 tools 전용 persisted 필터를 hydration하면 기본 메시지·응답으로 복구한다', async () => {
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(JSON.stringify({
    state: {
      scope: 'messages',
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        eventCategories: ['tools'],
      },
      recentQueries: ['needle'],
      recentSessionIds: [],
    },
    version: 1,
  }));
  jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue();

  await useSearchStore.persist.rehydrate();

  expect(useSearchStore.getState()).toMatchObject({
    scope: 'messages',
    filters: {
      eventCategories: ['messages', 'responses'],
    },
    recentQueries: ['needle'],
  });
});
