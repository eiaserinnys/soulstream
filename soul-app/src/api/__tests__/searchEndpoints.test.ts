import { createApiClient } from '../client';
import { normalizeSearchMatchSource } from '../searchEndpoints';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://search.example';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
}

beforeEach(() => {
  useAuthStore.setState({ jwt: 'search-jwt' });
  (global as any).fetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({
      sessions: [{
        agentSessionId: 'session-1',
        displayName: 'Alpha',
        status: 'completed',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    }))
    .mockResolvedValueOnce(jsonResponse({
      results: [{
        session_id: 'session-1',
        event_id: 42,
        event_type: 'assistant_message',
        preview: 'Alpha answer',
        score: 0.9,
        match_source: 'turn_summary',
      }],
      navigation_results: [{
        kind: 'folder',
        id: 'folder-a',
        title: 'Alpha task',
        folder_id: 'folder-a',
        project_page_id: 'project-page-a',
      }],
      session_results: [{
        session_id: 'session-1',
        title: 'Alpha work',
        excerpt: 'Alpha answer',
        folder_id: 'folder-a',
        folder_title: 'Alpha task',
        best_match: { event_id: 42, match_source: 'message', excerpt: 'Alpha answer' },
        session_url: '/?session=session-1&event=42',
      }],
      search_status: {
        search: {
          status: 'partial',
          stage: 'lexical',
          reason: 'timeout',
        },
        query_expansion: {
          status: 'partial',
          reason: 'configuration',
          latency_ms: 0,
        },
        search_latency_ms: 321,
      },
    }));
});

test('세션 메타 검색과 본문 BM25 검색을 같은 인증·취소 계약으로 호출한다', async () => {
  const controller = new AbortController();
  const api = createApiClient(BASE);

  await expect(api.searchSessions({
    query: 'Alpha',
    folderId: 'folder/one',
    nodeId: 'node-a',
    statuses: ['completed', 'error'],
    backends: ['codex'],
    updatedAfter: '2026-09-16T00:00:00.000Z',
    limit: 20,
  }, controller.signal)).resolves.toMatchObject({
    sessions: [{ agentSessionId: 'session-1' }],
    total: 1,
  });
  await expect(api.searchSessionMessages({
    query: 'Alpha',
    topK: 40,
    eventCategories: ['messages', 'responses'],
    searchSessionId: true,
    sessionFilters: {
      folderId: 'folder/one',
      nodeId: 'node-a',
      statuses: ['completed', 'error'],
      backends: ['codex'],
      updatedAfter: '2026-09-16T00:00:00.000Z',
    },
  }, controller.signal)).resolves.toMatchObject({
    results: [{
      sessionId: 'session-1',
      eventId: 42,
      matchSource: 'turn_summary',
    }],
    navigationResults: [{ kind: 'folder', id: 'folder-a' }],
    sessionResults: [{
      sessionId: 'session-1',
      title: 'Alpha work',
      excerpt: 'Alpha answer',
      folderId: 'folder-a',
      folderTitle: 'Alpha task',
      bestMatch: { eventId: 42, matchSource: 'message', excerpt: 'Alpha answer' },
      sessionUrl: '/?session=session-1&event=42',
    }],
    searchStatus: {
      search: {
        status: 'partial',
        stage: 'lexical',
        reason: 'timeout',
      },
      queryExpansion: {
        status: 'partial',
        reason: 'configuration',
        latencyMs: 0,
      },
      searchLatencyMs: 321,
      dbCancelFailed: false,
    },
  });

  const calls = (global.fetch as jest.Mock).mock.calls;
  expect(calls[0][0]).toBe(
    `${BASE}/api/sessions?search=Alpha&folder_id=folder%2Fone&node_id=node-a&status=completed%2Cerror&backend=codex&updated_after=2026-09-16T00%3A00%3A00.000Z&limit=20`,
  );
  expect(calls[1][0]).toBe(
    `${BASE}/cogito/search?q=Alpha&top_k=40&search_session_id=true&include_session_results=true&session_folder_id=folder%2Fone&session_node_id=node-a&session_statuses=completed%2Cerror&session_backends=codex&session_updated_after=2026-09-16T00%3A00%3A00.000Z&event_categories=messages%2Cresponses`,
  );
  for (const [, init] of calls) {
    expect((init as RequestInit).signal).toBe(controller.signal);
    expect(((init as RequestInit).headers as Headers).get('Authorization'))
      .toBe('Bearer search-jwt');
  }
});

test('선택한 포함 범위만 새 검색 플래그로 보낸다', async () => {
  (global.fetch as jest.Mock).mockReset().mockResolvedValueOnce(jsonResponse({
    results: [],
    navigation_results: [],
  }));
  const api = createApiClient(BASE);

  await api.searchSessionMessages({
    query: 'Alpha',
    includeTurnSummaries: true,
    includeHighlight: true,
    includeStory: true,
  });

  expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
    `${BASE}/cogito/search?q=Alpha&top_k=20&search_session_id=true&include_session_results=true&include_turn_summaries=true&include_highlight=true&include_story=true`,
  );
});

test('세션 projection 검색 단계를 query 계약으로 명시한다', async () => {
  (global.fetch as jest.Mock).mockReset().mockResolvedValueOnce(jsonResponse({
    results: [],
    navigation_results: [],
    session_results: [],
  }));
  const api = createApiClient(BASE);

  await api.searchSessionMessages({
    query: 'paraphrase query',
    includeSessionResults: true,
    sessionSearchMode: 'lexical',
  });

  expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
    `${BASE}/cogito/search?q=paraphrase+query&top_k=20&search_session_id=true&include_session_results=true&session_search_mode=lexical`,
  );
});

test('구서버가 새 플래그와 match_source를 지원하지 않아도 기존 메시지 결과로 처리한다', async () => {
  (global.fetch as jest.Mock).mockReset().mockResolvedValueOnce(jsonResponse({
    results: [{
      session_id: 'session-1',
      event_id: 42,
      event_type: 'assistant_message',
      preview: 'legacy answer',
      score: 0.9,
    }],
    navigation_results: [],
  }));
  const api = createApiClient(BASE);

  await expect(api.searchSessionMessages({
    query: 'legacy',
    includeTurnSummaries: true,
    includeHighlight: true,
    includeStory: true,
  })).resolves.toMatchObject({
    results: [{
      eventId: 42,
      matchSource: 'message',
    }],
  });
});

test('match_source 계약 이탈은 개발에서 드러내고 프로덕션에서는 message로 내린다', () => {
  expect(normalizeSearchMatchSource(undefined, true)).toBe('message');
  expect(() => normalizeSearchMatchSource('future', true)).toThrow(
    /match_source/,
  );
  expect(normalizeSearchMatchSource(undefined, false)).toBe('message');
  expect(normalizeSearchMatchSource('future', false)).toBe('message');
});
