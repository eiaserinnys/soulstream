import { ROOT_TAB_ORDER } from '../tabContract';
import {
  buildPhoneState,
  buildTabletState,
  readPhoneLocation,
  readTabletLocation,
  type NormalizedNavigationLocation,
  type TabletContinuityEffects,
  type TabletLocationContext,
} from '../layoutNavigationState';

type RouteSpec = { name: string; params?: Record<string, unknown> };

const phoneState = (tab: string, stack: RouteSpec[]): any => ({
  type: 'tab',
  index: ROOT_TAB_ORDER.indexOf(tab as (typeof ROOT_TAB_ORDER)[number]),
  routes: ROOT_TAB_ORDER.map(name => ({
    name,
    key: `tab-${name}`,
    state: name === tab
      ? { type: 'stack', index: stack.length - 1, routes: stack.map((route, index) => ({ ...route, key: `route-${name}-${index}` })) }
      : { type: 'stack', index: 0, routes: [{ name: 'Idle', key: `idle-${name}` }] },
  })),
});

const tabStack = (state: any, tab: string): any[] => state.routes.find((route: any) => route.name === tab).state.routes;
const tabIndex = (state: any): string => state.routes[state.index].name;
const topRoute = (state: any): any => {
  const stack = state.routes[state.index];
  return stack.state.routes[stack.state.index];
};

const folder = { folderPageId: 'page-1', folderTitle: '프로젝트', folderId: 'folder-1' };

const tabletContextFromEffects = (effects: TabletContinuityEffects): TabletLocationContext => ({
  lastMainFocus: effects.lastMainFocus,
  folderOverlayVisible: Boolean(effects.folderOverlay || effects.cardOverlay || effects.sessionOverlay),
  selectedFolder: effects.folderOverlay
    ? {
      folderPageId: effects.folderOverlay.folderPageId,
      folderTitle: effects.folderOverlay.folderTitle,
      folderId: effects.folderOverlay.folderId ?? undefined,
    }
    : null,
  selectedCardId: effects.cardOverlay?.cardId ?? null,
  activeSessionId: effects.folderOverlay?.sessionId ?? effects.cardOverlay?.sessionId ?? effects.sessionOverlay?.sessionId ?? null,
  settingsVisible: effects.settingsVisible,
  settingsCategory: effects.settingsCategory,
  recurringJobsPanel: effects.recurringJobsPanel ?? null,
  searchActive: effects.searchActive,
  searchQuery: effects.searchQuery,
  pasSelectedCardId: effects.pasSelectedCardId,
});

describe('readPhoneLocation', () => {
  test('빈 상태는 데일리 기본값이다', () => {
    expect(readPhoneLocation(undefined)).toEqual({ originTab: 'DailyTab', kind: 'daily' });
  });

  test('탭 안의 스택 최상단 화면과 하위 폴더 문맥을 읽는다', () => {
    expect(readPhoneLocation(phoneState('DailyTab', [{ name: 'Daily' }, { name: 'DailyHistory' }])))
      .toEqual({ originTab: 'DailyTab', kind: 'dailyHistory' });
    expect(readPhoneLocation(phoneState('FolderTab', [{ name: 'FolderList' }])))
      .toEqual({ originTab: 'FolderTab', kind: 'folderList' });
    expect(readPhoneLocation(phoneState('FolderTab', [{ name: 'FolderList' }, { name: 'FolderWorkspace', params: folder }])))
      .toEqual({ originTab: 'FolderTab', kind: 'folderWorkspace', folder });
    expect(readPhoneLocation(phoneState('FeedTab', [{ name: 'Feed' }, { name: 'Search', params: { initialQuery: '검색어' } }])))
      .toEqual({ originTab: 'FeedTab', kind: 'search', initialQuery: '검색어' });
  });

  test('채팅은 아래에 깔린 폴더·카드 문맥과 답장 복귀 탭을 보존한다', () => {
    expect(readPhoneLocation(phoneState('FeedTab', [
      { name: 'Feed' },
      { name: 'CardDetail', params: { cardId: 'card-1' } },
      { name: 'Chat', params: { sessionId: 'session-1', focusEventId: 7, returnTab: 'FolderTab' } },
    ]))).toEqual({
      originTab: 'FeedTab',
      kind: 'chat',
      sessionId: 'session-1',
      focusEventId: 7,
      returnTab: 'FolderTab',
      cardId: 'card-1',
    });
  });

  test('카드 상세·문서·PAS·설정·반복 작업 경로를 읽는다', () => {
    expect(readPhoneLocation(phoneState('FolderTab', [
      { name: 'FolderList' },
      { name: 'FolderWorkspace', params: folder },
      { name: 'CardDetail', params: { cardId: 'card-1' } },
    ]))).toEqual({ originTab: 'FolderTab', kind: 'cardDetail', cardId: 'card-1', folder });

    expect(readPhoneLocation(phoneState('PersistentTab', [
      { name: 'PersistentSession' },
      { name: 'CardDetail', params: { cardId: 'card-2' } },
    ]))).toEqual({
      originTab: 'PersistentTab',
      kind: 'cardDetail',
      cardId: 'card-2',
      pasCard: true,
    });

    expect(readPhoneLocation(phoneState('PersistentTab', [
      { name: 'PersistentSession' },
      { name: 'MarkdownDocument', params: { documentId: 'doc-1' } },
    ]))).toEqual({
      originTab: 'PersistentTab',
      kind: 'markdownDocument',
      documentId: 'doc-1',
      fromPersistent: true,
    });

    expect(readPhoneLocation(phoneState('SettingsTab', [{ name: 'Settings' }]), { settingsCategory: 'work' }))
      .toEqual({ originTab: 'SettingsTab', kind: 'settings', category: 'work' });
    expect(readPhoneLocation(phoneState('SettingsTab', [{ name: 'Settings' }, { name: 'RecurringJobs' }])))
      .toEqual({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } });
    expect(readPhoneLocation(phoneState('SettingsTab', [
      { name: 'Settings' },
      { name: 'RecurringJobs' },
      { name: 'RecurringJobEditor', params: { jobId: 'job-1' } },
    ]))).toEqual({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor', jobId: 'job-1' } });
    expect(readPhoneLocation(phoneState('SettingsTab', [
      { name: 'Settings' },
      { name: 'RecurringJobs' },
      { name: 'RecurringJobHistory', params: { jobId: 'job-2' } },
    ]))).toEqual({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } });
  });
});

describe('buildPhoneState', () => {
  test('항상 실제 탭 순서 5개를 만들고 활성 탭만 경로를 채운다', () => {
    const state = buildPhoneState({ originTab: 'PersistentTab', kind: 'persistentSession' });
    expect(state.routes.map(route => route.name)).toEqual([...ROOT_TAB_ORDER]);
    expect(tabIndex(state)).toBe('PersistentTab');
    expect(tabStack(state, 'PersistentTab').map(route => route.name)).toEqual(['PersistentSession']);
    expect(tabStack(state, 'DailyTab').map(route => route.name)).toEqual(['Daily']);
    expect(tabStack(state, 'SettingsTab').map(route => route.name)).toEqual(['Settings']);
  });

  test('채팅은 FeedTab에 열고 폴더 문맥은 FolderTab에 남긴다', () => {
    const state = buildPhoneState({
      originTab: 'FolderTab',
      kind: 'chat',
      sessionId: 'session-1',
      folder,
    });
    expect(tabIndex(state)).toBe('FeedTab');
    expect(tabStack(state, 'FolderTab').map(route => route.name)).toEqual(['FolderList', 'FolderWorkspace']);
    expect(tabStack(state, 'FolderTab')[1].params).toEqual(folder);
    expect(tabStack(state, 'FeedTab').map(route => route.name)).toEqual(['Feed', 'Chat']);
    expect(tabStack(state, 'FeedTab')[1].params).toMatchObject({ sessionId: 'session-1', returnTab: 'FolderTab' });
  });

  test('카드 상세는 출발 탭 스택에 쌓고 PAS 카드는 PersistentTab에 둔다', () => {
    const daily = buildPhoneState({ originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-1' });
    expect(tabIndex(daily)).toBe('DailyTab');
    expect(tabStack(daily, 'DailyTab').map(route => route.name)).toEqual(['Daily', 'CardDetail']);
    expect(tabStack(daily, 'DailyTab')[1].params).toEqual({ cardId: 'card-1' });

    const pas = buildPhoneState({ originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-2', pasCard: true });
    expect(tabStack(pas, 'PersistentTab').map(route => route.name)).toEqual(['PersistentSession', 'CardDetail']);
  });

  test('문서는 출발 탭 스택에 쌓고 PAS 문서는 PersistentSession 아래에 둔다', () => {
    const feed = buildPhoneState({ originTab: 'FeedTab', kind: 'markdownDocument', documentId: 'doc-1' });
    expect(tabStack(feed, 'FeedTab').map(route => route.name)).toEqual(['Feed', 'MarkdownDocument']);
    expect(topRoute(feed).params).toEqual({ documentId: 'doc-1' });

    const persistent = buildPhoneState({ originTab: 'FeedTab', kind: 'markdownDocument', documentId: 'doc-2', fromPersistent: true });
    expect(tabIndex(persistent)).toBe('PersistentTab');
    expect(tabStack(persistent, 'PersistentTab').map(route => route.name)).toEqual(['PersistentSession', 'MarkdownDocument']);
  });

  test('설정과 반복 작업 패널을 실제 route로 만든다', () => {
    const settings = buildPhoneState({ originTab: 'SettingsTab', kind: 'settings', category: 'work' });
    expect(tabIndex(settings)).toBe('SettingsTab');
    expect(tabStack(settings, 'SettingsTab').map(route => route.name)).toEqual(['Settings']);

    const editor = buildPhoneState({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor', jobId: 'job-1' } });
    expect(tabStack(editor, 'SettingsTab').map(route => route.name)).toEqual(['Settings', 'RecurringJobs', 'RecurringJobEditor']);
    expect(topRoute(editor).params).toEqual({ jobId: 'job-1' });

    const history = buildPhoneState({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } });
    expect(tabStack(history, 'SettingsTab').map(route => route.name)).toEqual(['Settings', 'RecurringJobs', 'RecurringJobHistory']);
    expect(topRoute(history).params).toEqual({ jobId: 'job-2' });
  });

  test.each<[string, NormalizedNavigationLocation]>([
    ['daily', { originTab: 'DailyTab', kind: 'daily' }],
    ['dailyHistory', { originTab: 'DailyTab', kind: 'dailyHistory' }],
    ['folderList', { originTab: 'FolderTab', kind: 'folderList' }],
    ['folderWorkspace', { originTab: 'FolderTab', kind: 'folderWorkspace', folder }],
    ['feed', { originTab: 'FeedTab', kind: 'feed' }],
    ['search', { originTab: 'FeedTab', kind: 'search', initialQuery: '검색어' }],
    ['persistentSession', { originTab: 'PersistentTab', kind: 'persistentSession' }],
    ['PAS cardDetail', { originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-2', pasCard: true }],
    ['Persistent markdown', { originTab: 'PersistentTab', kind: 'markdownDocument', documentId: 'doc-2', fromPersistent: true }],
    ['settings', { originTab: 'SettingsTab', kind: 'settings', category: 'work' }],
    ['recurring list', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } }],
    ['recurring editor', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor' } }],
    ['recurring history', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } }],
  ])('%s 위치는 phone 상태 왕복에서 보존된다', (_label, location) => {
    const expected = location.kind === 'settings'
      ? { originTab: 'SettingsTab', kind: 'settings', category: null }
      : location;
    expect(readPhoneLocation(buildPhoneState(location))).toEqual(expected);
  });
});

describe('buildTabletState', () => {
  test('Route가 아닌 화면은 Main 위 효과로 표현한다', () => {
    const history = buildTabletState({ originTab: 'DailyTab', kind: 'dailyHistory' });
    expect(history.initialState.routes.map(route => route.name)).toEqual(['Main']);
    expect(history.tabletEffects).toEqual({ activeSectionKind: 'daily', lastMainFocus: 'dailyHistory' });

    const workspace = buildTabletState({ originTab: 'FolderTab', kind: 'folderWorkspace', folder });
    expect(workspace.tabletEffects.folderOverlay).toEqual({ ...folder, sessionId: null });

    const search = buildTabletState({ originTab: 'FeedTab', kind: 'search', initialQuery: '검색어' });
    expect(search.tabletEffects).toMatchObject({ lastMainFocus: 'search', searchActive: true, searchQuery: '검색어' });

    const chat = buildTabletState({ originTab: 'FeedTab', kind: 'chat', sessionId: 'session-1', focusEventId: 7 });
    expect(chat.tabletEffects.sessionOverlay).toEqual({ sessionId: 'session-1', focusEventId: 7, storyOpenRequestId: undefined });

    const folderChat = buildTabletState({ originTab: 'FolderTab', kind: 'chat', sessionId: 'session-2', folder });
    expect(folderChat.tabletEffects.folderOverlay).toEqual({ ...folder, sessionId: 'session-2' });

    const cardOverlay = buildTabletState({ originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-1' });
    expect(cardOverlay.tabletEffects.cardOverlay).toEqual({ cardId: 'card-1', sessionId: null });
  });

  test('PAS 카드·문서는 실제 Tablet 스택을 쌓는다', () => {
    const pas = buildTabletState({ originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-2', pasCard: true });
    expect(pas.initialState.routes.map(route => route.name)).toEqual(['Main', 'PersistentSession']);
    expect(pas.initialState.routes[1].name).toBe('PersistentSession');
    expect(pas.tabletEffects.pasSelectedCardId).toBe('card-2');

    const doc = buildTabletState({ originTab: 'DailyTab', kind: 'markdownDocument', documentId: 'doc-1', fromPersistent: true });
    expect(doc.initialState.routes.map(route => route.name)).toEqual(['Main', 'PersistentSession', 'MarkdownDocument']);
    expect(doc.initialState.routes[2].params).toEqual({ documentId: 'doc-1' });

    const plain = buildTabletState({ originTab: 'FeedTab', kind: 'markdownDocument', documentId: 'doc-2' });
    expect(plain.initialState.routes.map(route => route.name)).toEqual(['Main', 'MarkdownDocument']);
  });

  test('설정·반복 작업은 설정 효과로 표현한다', () => {
    const settings = buildTabletState({ originTab: 'SettingsTab', kind: 'settings', category: 'work' });
    expect(settings.tabletEffects).toMatchObject({ settingsVisible: true, settingsCategory: 'work' });

    const editor = buildTabletState({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor', jobId: 'job-1' } });
    expect(editor.tabletEffects).toMatchObject({
      settingsVisible: true,
      settingsCategory: 'work',
      recurringJobsPanel: { kind: 'editor', jobId: 'job-1' },
    });
  });

  test.each<[string, NormalizedNavigationLocation]>([
    ['daily', { originTab: 'DailyTab', kind: 'daily' }],
    ['dailyHistory', { originTab: 'DailyTab', kind: 'dailyHistory' }],
    ['folderList', { originTab: 'FolderTab', kind: 'folderList' }],
    ['folderWorkspace', { originTab: 'FolderTab', kind: 'folderWorkspace', folder }],
    ['feed', { originTab: 'FeedTab', kind: 'feed' }],
    ['search', { originTab: 'FeedTab', kind: 'search', initialQuery: '검색어' }],
    ['chat', { originTab: 'FeedTab', kind: 'chat', sessionId: 'session-1' }],
    ['persistentSession', { originTab: 'PersistentTab', kind: 'persistentSession' }],
    ['PAS cardDetail', { originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-2', pasCard: true }],
    ['Persistent markdown', { originTab: 'PersistentTab', kind: 'markdownDocument', documentId: 'doc-2', fromPersistent: true }],
    ['settings', { originTab: 'SettingsTab', kind: 'settings', category: 'work' }],
    ['recurring list', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } }],
    ['recurring history', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } }],
  ])('%s 위치는 tablet 효과 왕복에서 보존된다', (_label, location) => {
    const built = buildTabletState(location);
    const restored = readTabletLocation(built.initialState, tabletContextFromEffects(built.tabletEffects));
    const expected = location.kind === 'recurringJobs'
      ? { ...location, originTab: 'SettingsTab', panel: location.panel }
      : location.kind === 'chat' && !location.folder && !location.cardId
        ? { ...location, returnTab: 'FeedTab' }
        : location;
    expect(restored).toEqual(expected);
  });
});

describe('readTabletLocation', () => {
  test('Main 위 효과의 우선순위를 지킨다', () => {
    const main = buildTabletState({ originTab: 'DailyTab', kind: 'daily' }).initialState;

    expect(readTabletLocation(main, { settingsVisible: true }))
      .toEqual({ originTab: 'SettingsTab', kind: 'settings', category: null });
    expect(readTabletLocation(main, { settingsVisible: true, recurringJobsPanel: { kind: 'list' } }))
      .toEqual({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } });
    expect(readTabletLocation(main, {
      folderOverlayVisible: true,
      selectedFolder: folder,
      activeSessionId: 'session-1',
    })).toEqual({ originTab: 'FolderTab', kind: 'chat', sessionId: 'session-1', folder, returnTab: 'FolderTab' });
    expect(readTabletLocation(main, { folderOverlayVisible: true, selectedFolder: folder }))
      .toEqual({ originTab: 'FolderTab', kind: 'folderWorkspace', folder });
    expect(readTabletLocation(main, { folderOverlayVisible: true, activeSessionId: 'session-2' }))
      .toEqual({ originTab: 'FeedTab', kind: 'chat', sessionId: 'session-2', returnTab: 'FeedTab' });
    expect(readTabletLocation(main, { folderOverlayVisible: true, selectedCardId: 'card-1' }))
      .toEqual({ originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-1' });
    expect(readTabletLocation(main, { searchActive: true, searchQuery: '검색어' }))
      .toEqual({ originTab: 'FeedTab', kind: 'search', initialQuery: '검색어' });
    expect(readTabletLocation(main, { lastMainFocus: 'folder' }))
      .toEqual({ originTab: 'FolderTab', kind: 'folderList' });
    expect(readTabletLocation(main, { lastMainFocus: 'dailyHistory' }))
      .toEqual({ originTab: 'DailyTab', kind: 'dailyHistory' });
    expect(readTabletLocation(undefined, {})).toEqual({ originTab: 'DailyTab', kind: 'daily' });
  });

  test('스택 아래 PersistentSession 여부로 PAS 문맥을 판별한다', () => {
    const withCard: any = {
      type: 'stack',
      key: 'tablet',
      index: 2,
      routes: [
        { name: 'Main', key: 'main' },
        { name: 'PersistentSession', key: 'persistent' },
        { name: 'CardDetail', key: 'card', params: { cardId: 'card-9' } },
      ],
    };
    expect(readTabletLocation(withCard)).toEqual({
      originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-9', pasCard: true,
    });

    const withDocument: any = {
      type: 'stack',
      key: 'tablet',
      index: 2,
      routes: [
        { name: 'Main', key: 'main' },
        { name: 'PersistentSession', key: 'persistent' },
        { name: 'MarkdownDocument', key: 'doc', params: { documentId: 'doc-9' } },
      ],
    };
    expect(readTabletLocation(withDocument)).toEqual({
      originTab: 'PersistentTab', kind: 'markdownDocument', documentId: 'doc-9', fromPersistent: true,
    });

    const persistentTop: any = {
      type: 'stack',
      key: 'tablet',
      index: 1,
      routes: [{ name: 'Main', key: 'main' }, { name: 'PersistentSession', key: 'persistent' }],
    };
    expect(readTabletLocation(persistentTop, { pasSelectedCardId: 'card-3' })).toEqual({
      originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-3', pasCard: true,
    });
    expect(readTabletLocation(persistentTop)).toEqual({ originTab: 'PersistentTab', kind: 'persistentSession' });
  });
});
