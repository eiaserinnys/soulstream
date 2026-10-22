import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { ROOT_TAB_ORDER } from '../tabContract';
import { LayoutContinuityProvider, useLayoutContinuity } from '../LayoutContinuityContext';
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

const tabletContextFromEffects = (
  effects: TabletContinuityEffects,
  previousLocation?: NormalizedNavigationLocation,
): TabletLocationContext => ({
  lastMainFocus: effects.lastMainFocus,
  previousLocation: previousLocation ?? null,
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

    expect(readPhoneLocation(phoneState('SettingsTab', [{ name: 'Settings' }]), { settingsCategory: 'recurring-jobs' }))
      .toEqual({ originTab: 'SettingsTab', kind: 'settings', category: 'recurring-jobs' });
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
    const settings = buildPhoneState({ originTab: 'SettingsTab', kind: 'settings', category: 'recurring-jobs' });
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
    ['cardDetail from daily', { originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-3' }],
    ['cardDetail from folder', { originTab: 'FolderTab', kind: 'cardDetail', cardId: 'card-4', folder }],
    ['markdown from feed', { originTab: 'FeedTab', kind: 'markdownDocument', documentId: 'doc-3' }],
    ['markdown from daily folder', { originTab: 'DailyTab', kind: 'markdownDocument', documentId: 'doc-4', folder }],
    ['chat with folder', { originTab: 'FolderTab', kind: 'chat', sessionId: 'session-1', folder, returnTab: 'FolderTab' }],
    ['chat with daily folder', { originTab: 'DailyTab', kind: 'chat', sessionId: 'session-2', folder, returnTab: 'DailyTab' }],
    ['chat with PAS card', { originTab: 'FeedTab', kind: 'chat', sessionId: 'session-3', cardId: 'card-5', returnTab: 'PersistentTab' }],
    ['settings', { originTab: 'SettingsTab', kind: 'settings', category: 'recurring-jobs' }],
    ['recurring list', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } }],
    ['recurring editor', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor' } }],
    ['recurring history', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } }],
  ])('%s 위치는 phone 상태 왕복에서 보존된다', (_label, location) => {
    const expected = location.kind === 'settings'
      ? { originTab: 'SettingsTab', kind: 'settings', category: null }
      : location.kind === 'chat'
        ? { ...location, originTab: 'FeedTab' }
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
    const settings = buildTabletState({ originTab: 'SettingsTab', kind: 'settings', category: 'recurring-jobs' });
    expect(settings.tabletEffects).toMatchObject({ settingsVisible: true, settingsCategory: 'recurring-jobs' });

    const editor = buildTabletState({ originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'editor', jobId: 'job-1' } });
    expect(editor.tabletEffects).toMatchObject({
      settingsVisible: true,
      settingsCategory: 'recurring-jobs',
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
    ['chat with folder', { originTab: 'FolderTab', kind: 'chat', sessionId: 'session-2', folder, returnTab: 'FolderTab' }],
    ['chat with card', { originTab: 'FeedTab', kind: 'chat', sessionId: 'session-3', cardId: 'card-5' }],
    ['cardDetail from daily', { originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-3' }],
    ['markdown from feed', { originTab: 'FeedTab', kind: 'markdownDocument', documentId: 'doc-3' }],
    ['persistentSession', { originTab: 'PersistentTab', kind: 'persistentSession' }],
    ['PAS cardDetail', { originTab: 'PersistentTab', kind: 'cardDetail', cardId: 'card-2', pasCard: true }],
    ['Persistent markdown', { originTab: 'PersistentTab', kind: 'markdownDocument', documentId: 'doc-2', fromPersistent: true }],
    ['settings', { originTab: 'SettingsTab', kind: 'settings', category: 'work' }],
    ['recurring list', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'list' } }],
    ['recurring history', { originTab: 'SettingsTab', kind: 'recurringJobs', panel: { kind: 'history', jobId: 'job-2' } }],
  ])('%s 위치는 tablet 효과 왕복에서 보존된다', (_label, location) => {
    const built = buildTabletState(location);
    const restored = readTabletLocation(
      built.initialState,
      tabletContextFromEffects(built.tabletEffects, location),
    );
    const expected = location.kind === 'recurringJobs'
      ? { ...location, originTab: 'SettingsTab', panel: location.panel }
      : location.kind === 'chat'
        ? {
          ...location,
          originTab: 'FeedTab',
          returnTab: location.returnTab ?? location.originTab,
          ...(location.cardId ? { folder: location.folder } : {}),
        }
        : location;
    expect(restored).toEqual(expected);
  });
});

describe('LayoutContinuityProvider', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(LayoutContinuityProvider, null, children);

  test('스크롤·초안·답장 대상·뷰 상태와 레이아웃 스냅샷을 메모리에 보관한다', () => {
    const { result } = renderHook(() => useLayoutContinuity(), { wrapper });

    act(() => {
      result.current.setScrollPosition('feed', { offsetY: 120, followBottom: true });
      result.current.writeScroll('folder', { offsetY: 8 });
      result.current.setMemoryDraft('auth-scope-1', 'chat', 'session-1', '초안');
      result.current.setComposerReplyTarget('session-1', { itemId: 4 });
      result.current.setViewState('settings', { category: 'recurring-jobs' });
      result.current.setPhoneStateSnapshot({ type: 'tab', key: 'phone', index: 0, routes: [] } as never);
      result.current.setLastLocation({ originTab: 'DailyTab', kind: 'daily' });
    });

    expect(result.current.getScrollPosition('feed')).toEqual({ offsetY: 120, followBottom: true });
    expect(result.current.readScroll('folder')).toEqual({ offsetY: 8 });
    expect(result.current.getMemoryDraft('auth-scope-1', 'chat', 'session-1')).toBe('초안');
    expect(result.current.getMemoryDraft('auth-scope-1', 'chat', 'session-2')).toBeUndefined();
    expect(result.current.getComposerReplyTarget<{ itemId: number }>('session-1')).toEqual({ itemId: 4 });
    expect(result.current.getViewState<{ category: string }>('settings')).toEqual({ category: 'recurring-jobs' });
    expect(result.current.getPhoneStateSnapshot()).toMatchObject({ key: 'phone' });
    expect(result.current.getTabletStateSnapshot()).toBeNull();
    expect(result.current.getLastLocation()).toEqual({ originTab: 'DailyTab', kind: 'daily' });

    act(() => result.current.clearMemoryDraftIfMatches('auth-scope-1', 'chat', 'session-1', '다른 값'));
    expect(result.current.getMemoryDraft('auth-scope-1', 'chat', 'session-1')).toBe('초안');
    act(() => result.current.clearMemoryDraftIfMatches('auth-scope-1', 'chat', 'session-1', '초안'));
    expect(result.current.getMemoryDraft('auth-scope-1', 'chat', 'session-1')).toBeUndefined();

    act(() => {
      result.current.setComposerReplyTarget('session-1', null);
      result.current.setLastLocation(null);
    });
    expect(result.current.getComposerReplyTarget('session-1')).toBeUndefined();
    expect(result.current.getLastLocation()).toBeNull();
  });
});

describe('readTabletLocation', () => {
  test('채팅의 복귀 탭과 폴더·카드 스택을 태블릿 왕복 뒤에도 보존한다', () => {
    const dailyFolderChat: NormalizedNavigationLocation = {
      originTab: 'FeedTab',
      kind: 'chat',
      sessionId: 'session-daily-folder',
      folder,
      returnTab: 'DailyTab',
    };
    const dailyTablet = buildTabletState(dailyFolderChat);
    const dailyRestored = readTabletLocation(
      dailyTablet.initialState,
      tabletContextFromEffects(dailyTablet.tabletEffects, dailyFolderChat),
    );
    expect(dailyRestored).toEqual(dailyFolderChat);
    expect(tabStack(buildPhoneState(dailyRestored), 'DailyTab').map(route => route.name))
      .toEqual(['Daily', 'FolderWorkspace']);

    const folderCardChat: NormalizedNavigationLocation = {
      originTab: 'FeedTab',
      kind: 'chat',
      sessionId: 'session-folder-card',
      folder,
      cardId: 'card-folder',
      returnTab: 'FolderTab',
    };
    const folderCardTablet = buildTabletState(folderCardChat);
    expect(folderCardTablet.tabletEffects.cardOverlay)
      .toEqual({ cardId: 'card-folder', sessionId: 'session-folder-card' });
    const folderCardRestored = readTabletLocation(
      folderCardTablet.initialState,
      tabletContextFromEffects(folderCardTablet.tabletEffects, folderCardChat),
    );
    expect(folderCardRestored).toEqual(folderCardChat);
    expect(tabStack(buildPhoneState(folderCardRestored), 'FolderTab').map(route => route.name))
      .toEqual(['FolderList', 'FolderWorkspace', 'CardDetail']);

    const pasCardChat: NormalizedNavigationLocation = {
      originTab: 'FeedTab',
      kind: 'chat',
      sessionId: 'session-pas-card',
      cardId: 'card-pas',
      returnTab: 'PersistentTab',
    };
    const pasTablet = buildTabletState(pasCardChat);
    const pasRestored = readTabletLocation(
      pasTablet.initialState,
      tabletContextFromEffects(pasTablet.tabletEffects, pasCardChat),
    );
    expect(pasRestored).toEqual(pasCardChat);
    expect(tabStack(buildPhoneState(pasRestored), 'PersistentTab').map(route => route.name))
      .toEqual(['PersistentSession', 'CardDetail']);
  });

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
    })).toEqual({ originTab: 'FeedTab', kind: 'chat', sessionId: 'session-1', folder, returnTab: 'FolderTab' });
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
