import { useSessionStore } from '../sessionStore';
import type { Session } from '../../api/types';
import { useAuthStore } from '../authStore';
import { useSettingsStore } from '../settingsStore';
import { captureAuthScope, resetAuthScopeForTest } from '../../lib/auth-scope';
import { usePlannerStore } from '../plannerStore';
import { useUIStore } from '../uiStore';
import { useChatStore } from '../chatStore';

function s(id: string, updatedAt = '2026-05-05T00:00:00Z'): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
  };
}

function reset() {
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' },
    catalogReady: false,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
    pendingAttentionVersionsBySession: {},
  });
}

function pendingAttention(id: string, sourceEventId: number, sessionId = 'attention') {
  return {
    id,
    sourceEventId,
    sessionId,
    kind: 'input_request' as const,
    requestedAt: `2026-09-07T00:00:${String(sourceEventId % 60).padStart(2, '0')}Z`,
    title: '입력 요청',
    body: `${id} 응답이 필요합니다`,
    requestId: id,
    requiresDetail: false,
  };
}

function setFeedRows(rows: Session[]): void {
  const state = useSessionStore.getState();
  state.applyFeedSnapshot({
    folders: state.catalog.folders,
    sessions: rows,
    total: rows.length,
    hasMore: false,
    nextCursor: null,
  });
}

describe('sessionStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ serverUrl: 'https://planner.test' });
    useAuthStore.setState({ jwt: 'scope-a' });
    resetAuthScopeForTest();
    reset();
  });

  test('auth generation 전환은 session·catalog projection을 동기적으로 비운다', () => {
    useSessionStore.getState().upsertSession(s('old-session'));
    useSessionStore.getState().setCatalog({
      folders: [{ id: 'old-folder', name: '이전 계정', sortOrder: 0 }],
      sessions: {},
    });
    const oldGeneration = captureAuthScope().generation;

    useAuthStore.getState().setJwt('scope-b');

    expect(useSessionStore.getState()).toMatchObject({
      sessions: {},
      catalog: { folders: [], sessions: {} },
      catalogReady: false,
      feedSessionIds: [],
    });
    expect(useSessionStore.getState().scopeGeneration).not.toBe(oldGeneration);
    expect(useSessionStore.getState().scopeGeneration).toBe(captureAuthScope().generation);
  });

  test('catalog load 상태는 실패·명시 재시도·정상 snapshot을 구분한다', () => {
    const store = useSessionStore.getState();

    store.markCatalogLoadFailed();
    expect(useSessionStore.getState().catalogLoadState).toBe('error');

    store.retryCatalog();
    expect(useSessionStore.getState()).toMatchObject({
      catalogLoadState: 'loading',
      catalogRetryRequest: 1,
    });

    store.setCatalog({ folders: [], sessions: {} });
    expect(useSessionStore.getState().catalogLoadState).toBe('loading');

    store.applyFeedSnapshot({
      folders: [], sessions: [], total: 0, hasMore: false, nextCursor: null,
    });
    expect(useSessionStore.getState().catalogLoadState).toBe('ready');
  });

  test('planner 진입 전역 projection과 overlay/chat 상태를 같은 transition에서 비운다', () => {
    usePlannerStore.setState({
      selectedFolderSnapshot: {
        page: { id: 'old-task', type: 'task', title: '이전 업무' },
        starred: false,
        project: null,
        context: null,
        runCount: 0,
        latestRunAt: null,
        latestRunStatus: null,

      } as any,
    });
    useSessionStore.getState().upsertSession(s('old-session'));
    useUIStore.setState({
      activeSessionId: 'old-session',
      selectedFolderPageId: 'old-task',
      folderOverlayVisible: true,
      sessionFolderResolution: { sessionId: 'old-session', status: 'loading' },
    });
    useChatStore.setState({
      eventsBySession: { 'old-session': [{ id: '1', type: 'assistant', data: {} } as any] },
      pendingFirstMessageBySession: { 'old-session': '이전 입력' },
      pendingOptimisticBySession: {
        'old-session': { id: 'optimistic-old', type: 'user_message', data: {} } as any,
      },
    });

    useAuthStore.getState().setJwt('scope-b');

    expect(usePlannerStore.getState().selectedFolderSnapshot).toBeNull();
    expect(useSessionStore.getState().sessions).toEqual({});
    expect(useUIStore.getState()).toMatchObject({
      activeSessionId: null,
      selectedFolderPageId: null,
      folderOverlayVisible: false,
      sessionFolderResolution: null,
    });
    expect(useChatStore.getState()).toMatchObject({
      eventsBySession: {},
      pendingFirstMessageBySession: {},
      pendingOptimisticBySession: {},
    });
  });

  test('setSessions: 빈 store에 list 주입 → entry 모두 추가', () => {
    const { setSessions } = useSessionStore.getState();
    setSessions([s('a'), s('b'), s('c')]);
    const ids = Object.keys(useSessionStore.getState().sessions).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  test('mergeSessions: 기존 entry 보존하면서 새 list 추가/갱신', () => {
    const { setSessions, mergeSessions } = useSessionStore.getState();
    setSessions([
      s('a', '2026-05-05T00:00:00Z'),
      s('b', '2026-05-04T00:00:00Z'),
    ]);
    // b 갱신 + c 추가 → a, b(갱신), c.
    mergeSessions([s('b', '2026-05-06T00:00:00Z'), s('c')]);

    const sessions = useSessionStore.getState().sessions;
    expect(Object.keys(sessions).sort()).toEqual(['a', 'b', 'c']);
    expect(sessions.b.updatedAt).toBe('2026-05-06T00:00:00Z');
  });

  test('pending attention snapshot은 key별 live revision의 기준선이 된다', () => {
    const initial = {
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    };
    useSessionStore.getState().setSessions([initial]);

    const store = useSessionStore.getState();
    store.applyPendingAttentionsDelta('attention', {
      'input_request:a': {
        revision: 110,
        value: pendingAttention('input_request:a', 110),
      },
    }, 110);
    store.applyPendingAttentionsDelta('attention', {
      'input_request:b': {
        revision: 105,
        value: pendingAttention('input_request:b', 105),
      },
    }, 105);

    expect(useSessionStore.getState().sessions.attention).toMatchObject({
      attentionRevision: 110,
      pendingAttentions: expect.arrayContaining([
        expect.objectContaining({ id: 'input_request:a', sourceEventId: 110 }),
        expect.objectContaining({ id: 'input_request:b', sourceEventId: 105 }),
      ]),
    });
    expect(
      useSessionStore.getState().pendingAttentionVersionsBySession.attention,
    ).toEqual({
      snapshotBaseline: 100,
      revisionsById: {
        'input_request:a': 110,
        'input_request:b': 105,
      },
    });
  });

  test('pending attention clear tombstone은 늦은 set을 차단하고 feed projection을 갱신한다', () => {
    const { setCatalog } = useSessionStore.getState();
    setCatalog({ folders: [], sessions: {} });
    setFeedRows([{
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:req-7', 1001)],
      attentionRevision: 1001,
    }]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:req-7': { revision: 1002, value: null },
    }, 1002);
    const clearedIds = useSessionStore.getState().feedSessionIds;
    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:req-7': {
        revision: 1001,
        value: pendingAttention('input_request:req-7', 1001),
      },
    }, 1001);

    expect(useSessionStore.getState().sessions.attention.pendingAttentions).toEqual([]);
    expect(
      useSessionStore.getState().pendingAttentionVersionsBySession.attention
        .revisionsById['input_request:req-7'],
    ).toBe(1002);
    expect(clearedIds).not.toBe(beforeIds);
    expect(useSessionStore.getState().feedSessionIds).toBe(clearedIds);
  });

  test('pending attention 내용만 바뀌고 비어있음 여부가 같으면 feed ids identity를 유지한다', () => {
    const { setCatalog } = useSessionStore.getState();
    setCatalog({ folders: [], sessions: {} });
    setFeedRows([{
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    }]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:a': {
        revision: 101,
        value: pendingAttention('input_request:a', 101),
      },
    }, 101);

    expect(useSessionStore.getState().feedSessionIds).toBe(beforeIds);
    expect(useSessionStore.getState().sessions.attention.pendingAttentions?.[0]
      .sourceEventId).toBe(101);
  });

  test('gap snapshot은 attention baseline을 교체하고 누락 snapshot은 기존 live 상태를 보존한다', () => {
    useSessionStore.getState().setSessions([{
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    }]);
    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:a': { revision: 110, value: null },
    }, 110);

    useSessionStore.getState().mergeSessions([{
      ...s('attention', '2026-09-07T00:02:00Z'),
      status: 'running',
    }]);
    expect(useSessionStore.getState().sessions.attention).toMatchObject({
      status: 'running',
      attentionRevision: 110,
      pendingAttentions: [],
    });

    useSessionStore.getState().mergeSessions([{
      ...s('attention', '2026-09-07T00:03:00Z'),
      pendingAttentions: [pendingAttention('input_request:b', 120)],
      attentionRevision: 120,
    }]);
    expect(
      useSessionStore.getState().pendingAttentionVersionsBySession.attention,
    ).toEqual({ snapshotBaseline: 120, revisionsById: {} });

    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:a': {
        revision: 119,
        value: pendingAttention('input_request:a', 119),
      },
    }, 119);
    expect(useSessionStore.getState().sessions.attention.pendingAttentions)
      .toEqual([pendingAttention('input_request:b', 120)]);
  });

  test('gap REST보다 먼저 적용된 최신 attention delta는 낮은 snapshot revision에 회귀하지 않는다', () => {
    useSessionStore.getState().setSessions([{
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    }]);
    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:a': { revision: 110, value: null },
      'input_request:b': {
        revision: 109,
        value: pendingAttention('input_request:b', 109),
      },
    }, 110);

    useSessionStore.getState().mergeSessions([{
      ...s('attention', '2026-09-07T00:04:00Z'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    }]);

    expect(useSessionStore.getState().sessions.attention).toMatchObject({
      attentionRevision: 110,
      pendingAttentions: [expect.objectContaining({ id: 'input_request:b' })],
    });
    expect(
      useSessionStore.getState().pendingAttentionVersionsBySession.attention,
    ).toEqual({
      snapshotBaseline: 100,
      revisionsById: {
        'input_request:a': 110,
        'input_request:b': 109,
      },
    });
  });

  test('늦은 gap snapshot은 최신 key를 보존하면서 snapshot에만 있던 독립 key를 복구한다', () => {
    useSessionStore.getState().setSessions([{
      ...s('attention'),
      pendingAttentions: [pendingAttention('input_request:a', 100)],
      attentionRevision: 100,
    }]);
    useSessionStore.getState().applyPendingAttentionsDelta('attention', {
      'input_request:a': {
        revision: 110,
        value: pendingAttention('input_request:a', 110),
      },
    }, 110);

    useSessionStore.getState().mergeSessions([{
      ...s('attention', '2026-09-07T00:05:00Z'),
      pendingAttentions: [
        pendingAttention('input_request:a', 100),
        pendingAttention('input_request:b', 105),
      ],
      attentionRevision: 105,
    }]);

    expect(useSessionStore.getState().sessions.attention).toMatchObject({
      attentionRevision: 110,
      pendingAttentions: expect.arrayContaining([
        expect.objectContaining({ id: 'input_request:a', sourceEventId: 110 }),
        expect.objectContaining({ id: 'input_request:b', sourceEventId: 105 }),
      ]),
    });
    expect(
      useSessionStore.getState().pendingAttentionVersionsBySession.attention,
    ).toEqual({
      snapshotBaseline: 105,
      revisionsById: { 'input_request:a': 110 },
    });
  });

  test('삭제·reconcile·auth reset은 attention revision tombstone도 함께 정리한다', () => {
    useSessionStore.getState().setSessions([
      {
        ...s('attention'),
        pendingAttentions: [pendingAttention('input_request:a', 100)],
        attentionRevision: 100,
      },
      {
        ...s('keep'),
        pendingAttentions: [],
        attentionRevision: 90,
      },
    ]);
    useSessionStore.getState().deleteSession('attention');
    expect(useSessionStore.getState().pendingAttentionVersionsBySession)
      .not.toHaveProperty('attention');

    useSessionStore.getState().setSessions([
      {
        ...s('attention'),
        pendingAttentions: [pendingAttention('input_request:a', 100)],
        attentionRevision: 100,
      },
      {
        ...s('keep'),
        pendingAttentions: [],
        attentionRevision: 90,
      },
    ]);
    useSessionStore.getState().reconcileSessions(new Set(['keep']));
    expect(Object.keys(useSessionStore.getState().pendingAttentionVersionsBySession))
      .toEqual(['keep']);

    useAuthStore.getState().setJwt('scope-b');
    expect(useSessionStore.getState().pendingAttentionVersionsBySession).toEqual({});
  });

  test('reconcileSessions: validIds에 있는 ID는 보존, 없는 ID는 제거', () => {
    const { setSessions, reconcileSessions } = useSessionStore.getState();
    setSessions([s('a'), s('b'), s('c'), s('d')]);
    reconcileSessions(new Set(['a', 'c']));
    const ids = Object.keys(useSessionStore.getState().sessions).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  test('reconcileSessions: 빈 validIds → store 비워짐', () => {
    const { setSessions, reconcileSessions } = useSessionStore.getState();
    setSessions([s('a'), s('b')]);
    reconcileSessions(new Set());
    expect(useSessionStore.getState().sessions).toEqual({});
  });

  test('reconcileSessions: 빈 store에서 호출해도 에러 없음', () => {
    const { reconcileSessions } = useSessionStore.getState();
    expect(() => reconcileSessions(new Set(['a', 'b']))).not.toThrow();
    expect(useSessionStore.getState().sessions).toEqual({});
  });

  test('agentSessionId 비어있는 entry는 setSessions/upsertSession에서 skip — 깨진 wire 가드', () => {
    const { setSessions, upsertSession } = useSessionStore.getState();
    setSessions([s('a'), { ...s('b'), agentSessionId: '' }]);
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual(['a']);
    upsertSession({ ...s('c'), agentSessionId: '' });
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual(['a']);
  });

  test('mergeSessions + reconcileSessions 조합 (gap refetch 흐름 재현)', () => {
    const { setSessions, mergeSessions, reconcileSessions } = useSessionStore.getState();

    // T0 — 초기 setSessions로 [s1, s2] 적재.
    setSessions([s('s1'), s('s2', '2026-05-04T00:00:00Z')]);
    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual([
      's1',
      's2',
    ]);

    // T1 — gap 발생 직전, 폴더 페이지네이션이 s3 추가.
    mergeSessions([s('s3')]);
    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual([
      's1',
      's2',
      's3',
    ]);

    // T2 — gap refetch 시뮬레이션:
    //   서버가 cat.sessionList = [s2(updated), s3]만 보냈고 (상위 50)
    //   서버 cat.sessions(폴더 매핑) = {s2, s3, s4} (s1은 그동안 다른 클라가 삭제).
    mergeSessions([s('s2', '2026-05-06T00:00:00Z'), s('s3')]);
    reconcileSessions(new Set(['s2', 's3', 's4']));

    const sessions = useSessionStore.getState().sessions;
    expect(Object.keys(sessions).sort()).toEqual(['s2', 's3']);
    // s1 — 서버에 없으므로 reconcile에서 제거.
    expect(sessions.s1).toBeUndefined();
    // s2 — 갱신본 반영.
    expect(sessions.s2.updatedAt).toBe('2026-05-06T00:00:00Z');
    // s4 — 서버 매핑엔 있으나 cat.sessionList에 없어서 store에는 추가되지 않음 (정상).
    expect(sessions.s4).toBeUndefined();
  });

  test('assignSessionToCatalog: 새 세션의 폴더 배정만 catalog에 추가', () => {
    const { setCatalog, assignSessionToCatalog } = useSessionStore.getState();
    setCatalog({
      folders: [{ id: 'f1', name: '작업', sortOrder: 0 }],
      sessions: { existing: { folderId: null, displayName: '기존' } },
    });

    assignSessionToCatalog('sess-new', 'f1', null);

    expect(useSessionStore.getState().catalog).toEqual({
      folders: [{ id: 'f1', name: '작업', sortOrder: 0 }],
      sessions: {
        existing: { folderId: null, displayName: '기존' },
        'sess-new': { folderId: 'f1', displayName: null },
      },
    });
  });

  test('applyCatalogDelta: 추가·수정·삭제를 병합하고 미변경 assignment identity를 보존한다', () => {
    const unchanged = { folderId: 'old', displayName: 'Unchanged' };
    const originalSessions = {
      unchanged,
      updated: { folderId: 'old', displayName: 'Before' },
      removed: { folderId: 'old', displayName: 'Remove me' },
    };
    const { setCatalog, applyCatalogDelta } = useSessionStore.getState();
    setCatalog({
      folders: [{ id: 'old', name: 'Old', sortOrder: 0 }],
      sessions: originalSessions,
    });

    applyCatalogDelta(
      [{ id: 'new', name: 'New', sortOrder: 0 }],
      {
        added: { folderId: 'new', displayName: 'Added' },
        updated: { folderId: 'new', displayName: 'After' },
        removed: null,
      },
    );

    const catalog = useSessionStore.getState().catalog;
    expect(catalog.sessions).not.toBe(originalSessions);
    expect(catalog.sessions.unchanged).toBe(unchanged);
    expect(catalog).toEqual({
      folders: [{ id: 'new', name: 'New', sortOrder: 0 }],
      sessions: {
        unchanged,
        updated: { folderId: 'new', displayName: 'After' },
        added: { folderId: 'new', displayName: 'Added' },
      },
    });
  });

  test('applyCatalogDelta: 빈 세션 델타는 sessions map identity를 보존하고 폴더만 갱신한다', () => {
    const originalSessions = {
      unchanged: { folderId: 'old', displayName: 'Unchanged' },
    };
    const { setCatalog, applyCatalogDelta } = useSessionStore.getState();
    setCatalog({
      folders: [{ id: 'old', name: 'Old', sortOrder: 0 }],
      sessions: originalSessions,
    });

    applyCatalogDelta(
      [{ id: 'renamed', name: 'Renamed', sortOrder: 0 }],
      {},
    );

    const catalog = useSessionStore.getState().catalog;
    expect(catalog.folders).toEqual([
      { id: 'renamed', name: 'Renamed', sortOrder: 0 },
    ]);
    expect(catalog.sessions).toBe(originalSessions);
  });

  test('feedSessionIds는 스냅샷 후보 안에서 catalog 기준 피드 순서를 유지한다', () => {
    const { setSessions, setCatalog } = useSessionStore.getState();
    const now = Date.now();
    const minutesAgo = (minutes: number) =>
      new Date(now - minutes * 60 * 1000).toISOString();
    setCatalog({
      folders: [
        { id: 'visible', name: '보임', sortOrder: 0 },
        {
          id: 'hidden',
          name: '숨김',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: {
        new: { folderId: 'visible', displayName: null },
        old: { folderId: 'visible', displayName: null },
        archived: { folderId: 'visible', displayName: null },
      },
    });

    const rows = [
      s('old', minutesAgo(30)),
      s('new', minutesAgo(10)),
      s('archived', minutesAgo(5)),
    ];
    setSessions(rows);
    useSessionStore.getState().applyFeedSnapshot({
      folders: [
        { id: 'visible', name: '보임', sortOrder: 0 },
        {
          id: 'hidden',
          name: '숨김',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: rows,
      total: rows.length,
      hasMore: false,
      nextCursor: null,
    });

    expect(useSessionStore.getState().feedSessionIds).toEqual(['archived', 'new', 'old']);

    useSessionStore.getState().assignSessionToCatalog('archived', 'hidden', null);
    expect(useSessionStore.getState().feedSessionIds).toEqual(['new', 'old']);
  });

  test('applyCatalogDelta: 제외 membership은 상세 session을 보존하면서 피드 카드만 제거한다', () => {
    const { setCatalog, setSessions, applyCatalogDelta } = useSessionStore.getState();
    setCatalog({
      folders: [
        { id: 'visible', name: '보임', sortOrder: 0 },
        {
          id: 'hidden',
          name: '피드 제외',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: { moving: { folderId: 'visible', displayName: null } },
    });
    setSessions([{ ...s('moving'), folderId: 'visible' }]);
    useSessionStore.getState().applyFeedSnapshot({
      folders: [
        { id: 'visible', name: '보임', sortOrder: 0 },
        {
          id: 'hidden',
          name: '피드 제외',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: [{ ...s('moving'), folderId: 'visible' }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });
    const detailSession = useSessionStore.getState().sessions.moving;

    expect(useSessionStore.getState().feedSessionIds).toEqual(['moving']);

    // feed_only catalog SSE는 visible → excluded 이동을 null assignment로 보낸다.
    applyCatalogDelta(
      [
        { id: 'visible', name: '보임', sortOrder: 0 },
        {
          id: 'hidden',
          name: '피드 제외',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      { moving: null },
    );

    expect(useSessionStore.getState().sessions.moving).toBe(detailSession);
    expect(useSessionStore.getState().feedSessionIds).toEqual([]);

    applyCatalogDelta(
      [{ id: 'visible', name: '보임', sortOrder: 0 }],
      { moving: { folderId: 'visible', displayName: null } },
    );

    expect(useSessionStore.getState().feedSessionIds).toEqual(['moving']);

    applyCatalogDelta(
      [
        {
          id: 'hidden',
          name: '피드 제외',
          sortOrder: 0,
          settings: { excludeFromFeed: true },
        },
      ],
      { moving: null },
    );

    // 새 창은 이전 excluded 기록을 버리고 들어온 snapshot의 후보만 다시 정한다.
    useSessionStore.getState().applyFeedSnapshot({
      folders: [
        {
          id: 'hidden',
          name: '피드 제외',
          sortOrder: 0,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: [{ ...s('moving'), folderId: 'hidden' }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });

    expect(useSessionStore.getState().feedSessionIds).toEqual([]);

    useSessionStore.getState().applyFeedSnapshot({
      folders: [{ id: 'visible', name: '보임', sortOrder: 0 }],
      sessions: [{ ...s('moving'), folderId: 'visible' }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });

    expect(useSessionStore.getState().feedSessionIds).toEqual(['moving']);
  });

  test('applyFeedSnapshot: 첫 쪽 후보만 보이고 화면 밖 상세 cache는 보존한다', () => {
    const {
      setCatalog,
      setSessions,
    } = useSessionStore.getState();
    setCatalog({
      folders: [{ id: 'visible', name: '보임', sortOrder: 0 }],
      sessions: {
        visible: { folderId: 'visible', displayName: null },
        detail: { folderId: 'visible', displayName: null },
      },
    });
    setSessions([
      { ...s('visible'), folderId: 'visible' },
      { ...s('detail'), folderId: 'visible' },
    ]);
    const detail = useSessionStore.getState().sessions.detail;

    useSessionStore.getState().applyFeedSnapshot({
      folders: [{ id: 'visible', name: '보임', sortOrder: 0 }],
      sessions: [{ ...s('visible'), folderId: 'visible' }],
      total: 1,
      hasMore: true,
      nextCursor: '30',
    });

    expect(useSessionStore.getState().sessions.detail).toBe(detail);
    expect(useSessionStore.getState().feedMembership).toEqual({ visible: 'candidate' });
    expect(useSessionStore.getState().feedSessionIds).toEqual(['visible']);
    useSessionStore.getState().updateSession('detail', { status: 'running' });
    expect(useSessionStore.getState().feedSessionIds).toEqual(['visible']);
  });

  test('복귀 스냅샷은 새 후보를 등록하고 이전 페이지 cache는 보존한다', () => {
    const { setCatalog, setSessions } = useSessionStore.getState();
    const catalog = {
      folders: [{ id: 'visible', name: '보임', sortOrder: 0 }],
      sessions: {
        visible: { folderId: 'visible', displayName: null },
        detail: { folderId: 'visible', displayName: null },
      },
    };
    setCatalog(catalog);
    setSessions([
      { ...s('visible'), folderId: 'visible' },
      { ...s('detail'), folderId: 'visible' },
    ]);
    const detail = useSessionStore.getState().sessions.detail;

    useSessionStore.getState().applyFeedSnapshot({
      folders: catalog.folders,
      sessions: [{ ...s('visible'), folderId: 'visible' }],
      total: 2,
      hasMore: true,
      nextCursor: '30',
    });

    expect(useSessionStore.getState().sessions.detail).toBe(detail);
    expect(useSessionStore.getState().feedMembership).toEqual({ visible: 'candidate' });
    expect(useSessionStore.getState().feedSessionIds).toEqual(['visible']);
  });

  test('일반 cache 주입은 후보를 만들지 않고 첫 snapshot이 피드 행을 확정한다', () => {
    const { setSessions, setCatalog } = useSessionStore.getState();

    setSessions([
      { ...s('hidden', '2026-05-05T00:00:00Z'), folderId: 'hidden' },
      { ...s('visible', '2026-05-04T00:00:00Z'), folderId: 'visible' },
    ]);

    expect(useSessionStore.getState().feedSessionIds).toEqual([]);

    setCatalog({
      folders: [
        {
          id: 'hidden',
          name: '숨김',
          sortOrder: 0,
          settings: { excludeFromFeed: true },
        },
        { id: 'visible', name: '보임', sortOrder: 1 },
      ],
      sessions: {
        hidden: { folderId: 'hidden', displayName: null },
        visible: { folderId: 'visible', displayName: null },
      },
    });

    expect(useSessionStore.getState().feedSessionIds).toEqual([]);
    useSessionStore.getState().applyFeedSnapshot({
      folders: [
        {
          id: 'hidden',
          name: '숨김',
          sortOrder: 0,
          settings: { excludeFromFeed: true },
        },
        { id: 'visible', name: '보임', sortOrder: 1 },
      ],
      sessions: [useSessionStore.getState().sessions.visible],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(useSessionStore.getState().feedSessionIds).toEqual(['visible']);
  });

  test('updateSession: 카드 내부 정보만 바뀌면 feedSessionIds 참조를 유지한다', () => {
    const { updateSession } = useSessionStore.getState();
    setFeedRows([s('a', new Date(Date.now() - 60_000).toISOString())]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    updateSession('a', { displayName: '새 이름' });

    expect(useSessionStore.getState().sessions.a.displayName).toBe('새 이름');
    expect(useSessionStore.getState().feedSessionIds).toBe(beforeIds);
  });

  test('updateSession: 유효 메시지가 그대로면 raw updatedAt 변경은 feed 순서·identity를 유지한다', () => {
    const { setCatalog, updateSession } = useSessionStore.getState();
    setCatalog({ folders: [], sessions: {} });
    setFeedRows([
      {
        ...s('a', '2026-05-05T00:00:00Z'),
        lastMessage: {
          type: 'assistant_message',
          preview: 'A',
          timestamp: '2026-05-05T00:00:00Z',
        },
      },
      {
        ...s('b', '2026-05-04T00:00:00Z'),
        lastMessage: {
          type: 'assistant_message',
          preview: 'B',
          timestamp: '2026-05-04T00:00:00Z',
        },
      },
    ]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    updateSession('b', { updatedAt: '2026-05-06T00:00:00Z' });

    expect(useSessionStore.getState().sessions.b.updatedAt).toBe('2026-05-06T00:00:00Z');
    expect(useSessionStore.getState().feedSessionIds).toBe(beforeIds);
    expect(useSessionStore.getState().feedSessionIds).toEqual(['a', 'b']);
  });

  test('updateSession: 유효 lastMessage.timestamp 변경은 feed를 재정렬한다', () => {
    const { setCatalog, updateSession } = useSessionStore.getState();
    setCatalog({ folders: [], sessions: {} });
    setFeedRows([s('a', '2026-05-05T00:00:00Z'), s('b', '2026-05-04T00:00:00Z')]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    updateSession('b', {
      lastMessage: {
        type: 'user_message',
        preview: '새 메시지',
        timestamp: '2026-05-06T00:00:00Z',
      },
    });

    expect(useSessionStore.getState().feedSessionIds).not.toBe(beforeIds);
    expect(useSessionStore.getState().feedSessionIds).toEqual(['b', 'a']);
  });

  test('updateSession: 그룹을 바꾸는 status는 feed projection을 갱신한다', () => {
    const { updateSession } = useSessionStore.getState();
    setFeedRows([s('a', new Date(Date.now() - 60_000).toISOString())]);
    const beforeIds = useSessionStore.getState().feedSessionIds;

    updateSession('a', { status: 'running' });

    expect(useSessionStore.getState().sessions.a.status).toBe('running');
    expect(useSessionStore.getState().feedSessionIds).not.toBe(beforeIds);
  });

  test('updateSession: 실제 변경 없는 text_delta-like patch는 sessions 참조도 유지한다', () => {
    const { updateSession } = useSessionStore.getState();
    setFeedRows([
      { ...s('a', new Date(Date.now() - 60_000).toISOString()), status: 'running' },
    ]);
    const beforeSessions = useSessionStore.getState().sessions;
    const beforeIds = useSessionStore.getState().feedSessionIds;

    updateSession('a', { status: 'running' });

    expect(useSessionStore.getState().sessions).toBe(beforeSessions);
    expect(useSessionStore.getState().feedSessionIds).toBe(beforeIds);
  });
});
