// 모듈 크기 예외: 이 파일은 정규화 위치·효과 타입 정의와 실제 route 이름/params 매핑 테이블이
// 본체다. #562 위임서가 변경 파일을 5개로 고정했으므로 별도 타입 모듈로 분리하지 않는다.
import type { InitialState, NavigationState, PartialState } from '@react-navigation/native';
import { ROOT_TAB_ORDER } from './tabContract';
import type { PhoneReturnTab } from './phonePanelHistory';

export type PhoneTabName = (typeof ROOT_TAB_ORDER)[number];
export type MainFocusKind = 'cards' | 'feed' | 'folder' | 'dailyHistory' | 'search';
export type RecurringJobsPanelState =
  | { kind: 'list' }
  | { kind: 'editor'; jobId?: string }
  | { kind: 'history'; jobId: string };

export type FolderWorkspaceContext = {
  folderPageId: string;
  folderTitle: string;
  folderId?: string;
};

export type NormalizedNavigationLocation =
  | { originTab: PhoneTabName; kind: 'daily'; date?: string }
  | { originTab: PhoneTabName; kind: 'dailyHistory' }
  | { originTab: PhoneTabName; kind: 'folderList' }
  | { originTab: PhoneTabName; kind: 'folderWorkspace'; folder: FolderWorkspaceContext }
  | { originTab: PhoneTabName; kind: 'feed' }
  | { originTab: PhoneTabName; kind: 'search'; initialQuery?: string }
  | {
    originTab: PhoneTabName;
    kind: 'chat';
    sessionId: string;
    focusEventId?: number;
    storyOpenRequestId?: number;
    usageEntry?: 'notification';
    returnTab?: PhoneReturnTab;
    folder?: FolderWorkspaceContext;
    cardId?: string;
  }
  | {
    originTab: PhoneTabName;
    kind: 'cardDetail';
    cardId: string;
    folder?: FolderWorkspaceContext;
    pasCard?: boolean;
  }
  | { originTab: PhoneTabName; kind: 'persistentSession' }
  | {
    originTab: PhoneTabName;
    kind: 'markdownDocument';
    documentId: string;
    folder?: FolderWorkspaceContext;
    cardId?: string;
    fromPersistent?: boolean;
  }
  | { originTab: PhoneTabName; kind: 'settings'; category?: string | null }
  | { originTab: PhoneTabName; kind: 'recurringJobs'; panel: RecurringJobsPanelState };

export type TabletLocationContext = {
  lastMainFocus?: MainFocusKind;
  activeSection?: { kind: 'daily'; date: string } | { kind: 'project'; folderId: string; projectPageId: string };
  folderOverlayVisible?: boolean;
  selectedFolder?: FolderWorkspaceContext | null;
  selectedCardId?: string | null;
  activeSessionId?: string | null;
  settingsVisible?: boolean;
  settingsCategory?: string | null;
  recurringJobsPanel?: RecurringJobsPanelState | null;
  searchActive?: boolean;
  searchQuery?: string;
  pasSelectedCardId?: string | null;
  previousLocation?: NormalizedNavigationLocation | null;
};

export type TabletContinuityEffects = {
  lastMainFocus?: MainFocusKind;
  activeSectionKind?: 'daily' | 'project';
  folderOverlay?: { folderPageId: string; folderTitle: string; folderId?: string | null; sessionId?: string | null } | null;
  cardOverlay?: { cardId: string; sessionId?: string | null } | null;
  sessionOverlay?: { sessionId: string; focusEventId?: number; storyOpenRequestId?: number } | null;
  settingsVisible?: boolean;
  settingsCategory?: string | null;
  recurringJobsPanel?: RecurringJobsPanelState | null;
  searchActive?: boolean;
  searchQuery?: string;
  pasSelectedCardId?: string | null;
};

export type PhoneReadContext = {
  settingsCategory?: string | null;
  folderById?: Record<string, FolderWorkspaceContext>;
  previousLocation?: NormalizedNavigationLocation | null;
};

type AnyNavState = NavigationState | PartialState<NavigationState>;
type LooseRoute = { name?: string; params?: Record<string, unknown>; state?: AnyNavState };
type LooseState = { index?: number; routes?: LooseRoute[] };
type RouteSpec = { name: string; params?: Record<string, unknown> };

const PHONE_TABS = ROOT_TAB_ORDER as readonly PhoneTabName[];
const RECURRING_JOBS_CATEGORY = 'recurring-jobs';

function isPhoneTab(name: unknown): name is PhoneTabName {
  return typeof name === 'string' && (PHONE_TABS as readonly string[]).includes(name);
}

function loose(state: AnyNavState | undefined | null): LooseState {
  return (state ?? {}) as LooseState;
}

function routesOf(state: AnyNavState | undefined | null): LooseRoute[] {
  const routes = loose(state).routes;
  return Array.isArray(routes) ? routes : [];
}

function activeRoute(state: AnyNavState | undefined | null): LooseRoute | undefined {
  const routes = routesOf(state);
  if (routes.length === 0) return undefined;
  const index = loose(state).index;
  const safeIndex = typeof index === 'number' ? Math.min(Math.max(index, 0), routes.length - 1) : 0;
  return routes[safeIndex];
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = params?.[key];
  return typeof value === 'number' ? value : undefined;
}

function folderFromParams(params: Record<string, unknown> | undefined): FolderWorkspaceContext | undefined {
  const folderPageId = stringParam(params, 'folderPageId');
  const folderTitle = stringParam(params, 'folderTitle');
  if (folderPageId === undefined || folderTitle === undefined) return undefined;
  return { folderPageId, folderTitle, folderId: stringParam(params, 'folderId') };
}

function folderOfRoute(route: LooseRoute, folderById?: Record<string, FolderWorkspaceContext>): FolderWorkspaceContext | undefined {
  const folder = folderFromParams(route.params);
  if (!folder) return undefined;
  return folderById?.[folder.folderPageId] ?? folder;
}

function lastFolder(routes: LooseRoute[], folderById?: Record<string, FolderWorkspaceContext>): FolderWorkspaceContext | undefined {
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (routes[index].name === 'FolderWorkspace') return folderOfRoute(routes[index], folderById);
  }
  return undefined;
}

function lastCardId(routes: LooseRoute[]): string | undefined {
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (routes[index].name !== 'CardDetail') continue;
    const cardId = stringParam(routes[index].params, 'cardId');
    if (cardId !== undefined) return cardId;
  }
  return undefined;
}

function stackRoutesInTab(rootState: AnyNavState | undefined, tab: PhoneTabName): LooseRoute[] {
  const tabRoute = routesOf(rootState).find(route => route.name === tab);
  return routesOf(tabRoute?.state);
}

function stackRoutesOf(route: LooseRoute | undefined): { routes: LooseRoute[]; topIndex: number; top: LooseRoute | undefined } {
  const routes = routesOf(route?.state);
  const top = activeRoute(route?.state);
  const topIndex = top ? routes.indexOf(top) : routes.length - 1;
  return { routes, topIndex, top };
}

function folderOfLocation(location: NormalizedNavigationLocation | null | undefined): FolderWorkspaceContext | undefined {
  return location && 'folder' in location ? location.folder : undefined;
}

export function readPhoneLocation(
  state: NavigationState | PartialState<NavigationState> | undefined,
  context: PhoneReadContext = {},
): NormalizedNavigationLocation {
  const tabRoute = activeRoute(state);
  const originTab = isPhoneTab(tabRoute?.name) ? tabRoute.name : 'DailyTab';
  const { routes, topIndex, top } = stackRoutesOf(tabRoute);

  if (!top) return defaultPhoneLocation(originTab);

  const belowTop = routes.slice(0, Math.max(topIndex, 0));
  const folder = lastFolder(belowTop, context.folderById);
  const cardId = lastCardId(belowTop);

  switch (top.name) {
    case 'Daily':
      return { originTab, kind: 'daily' };
    case 'DailyHistory':
      return { originTab, kind: 'dailyHistory' };
    case 'FolderList':
      return { originTab, kind: 'folderList' };
    case 'FolderWorkspace': {
      const ownFolder = folderOfRoute(top, context.folderById);
      return ownFolder
        ? { originTab, kind: 'folderWorkspace', folder: ownFolder }
        : defaultPhoneLocation(originTab);
    }
    case 'Feed':
      return { originTab, kind: 'feed' };
    case 'Search':
      return { originTab, kind: 'search', initialQuery: stringParam(top.params, 'initialQuery') };
    case 'Chat': {
      const returnTab = isPhoneTab(top.params?.returnTab) ? top.params?.returnTab : undefined;
      const contextTab = returnTab ?? originTab;
      const contextRoutes = contextTab === originTab ? routes : stackRoutesInTab(state, contextTab);
      const usageEntry = top.params?.usageEntry === 'notification' ? 'notification' as const : undefined;
      return {
        originTab,
        kind: 'chat',
        sessionId: stringParam(top.params, 'sessionId') ?? '',
        focusEventId: numberParam(top.params, 'focusEventId'),
        storyOpenRequestId: numberParam(top.params, 'storyOpenRequestId'),
        usageEntry,
        returnTab,
        folder: folder ?? lastFolder(contextRoutes, context.folderById) ?? folderOfLocation(context.previousLocation),
        cardId: cardId ?? lastCardId(contextRoutes),
      };
    }
    case 'CardDetail': {
      const ownCardId = stringParam(top.params, 'cardId');
      if (ownCardId === undefined) return defaultPhoneLocation(originTab);
      return {
        originTab,
        kind: 'cardDetail',
        cardId: ownCardId,
        folder,
        pasCard: originTab === 'PersistentTab' ? true : undefined,
      };
    }
    case 'PersistentSession':
      return { originTab, kind: 'persistentSession' };
    case 'MarkdownDocument': {
      const documentId = stringParam(top.params, 'documentId');
      if (documentId === undefined) return defaultPhoneLocation(originTab);
      return {
        originTab,
        kind: 'markdownDocument',
        documentId,
        folder,
        cardId,
        fromPersistent: originTab === 'PersistentTab' ? true : undefined,
      };
    }
    case 'Settings':
      return { originTab, kind: 'settings', category: context.settingsCategory ?? null };
    case 'RecurringJobs':
      return { originTab, kind: 'recurringJobs', panel: { kind: 'list' } };
    case 'RecurringJobEditor': {
      const jobId = stringParam(top.params, 'jobId');
      return {
        originTab,
        kind: 'recurringJobs',
        panel: jobId === undefined ? { kind: 'editor' } : { kind: 'editor', jobId },
      };
    }
    case 'RecurringJobHistory':
      return {
        originTab,
        kind: 'recurringJobs',
        panel: { kind: 'history', jobId: stringParam(top.params, 'jobId') ?? '' },
      };
    default:
      return defaultPhoneLocation(originTab);
  }
}

function defaultPhoneLocation(originTab: PhoneTabName): NormalizedNavigationLocation {
  switch (originTab) {
    case 'FolderTab':
      return { originTab, kind: 'folderList' };
    case 'FeedTab':
      return { originTab, kind: 'feed' };
    case 'PersistentTab':
      return { originTab, kind: 'persistentSession' };
    case 'SettingsTab':
      return { originTab, kind: 'settings', category: null };
    default:
      return { originTab, kind: 'daily' };
  }
}

export function readTabletLocation(
  state: NavigationState | PartialState<NavigationState> | undefined,
  context: TabletLocationContext = {},
): NormalizedNavigationLocation {
  const routes = routesOf(state);
  const top = activeRoute(state);
  const topIndex = top ? routes.indexOf(top) : -1;
  const persistentBelow = topIndex > 0
    ? routes.slice(0, topIndex).some(route => route.name === 'PersistentSession')
    : false;
  const previousTab = context.previousLocation?.originTab ?? 'DailyTab';

  switch (top?.name) {
    case 'MarkdownDocument': {
      const documentId = stringParam(top.params, 'documentId');
      if (documentId === undefined) return tabletMainLocation(context);
      const fromPersistent = persistentBelow;
      return {
        originTab: fromPersistent ? 'PersistentTab' : previousTab,
        kind: 'markdownDocument',
        documentId,
        fromPersistent: fromPersistent ? true : undefined,
      };
    }
    case 'CardDetail': {
      const cardId = stringParam(top.params, 'cardId');
      if (cardId === undefined) return tabletMainLocation(context);
      const pasCard = persistentBelow;
      return {
        originTab: pasCard ? 'PersistentTab' : previousTab,
        kind: 'cardDetail',
        cardId,
        pasCard: pasCard ? true : undefined,
      };
    }
    case 'PersistentSession': {
      const pasCardId = context.pasSelectedCardId;
      if (pasCardId) {
        return {
          originTab: 'PersistentTab',
          kind: 'cardDetail',
          cardId: pasCardId,
          pasCard: true,
        };
      }
      return { originTab: 'PersistentTab', kind: 'persistentSession' };
    }
    default:
      return tabletMainLocation(context);
  }
}

function tabletMainLocation(context: TabletLocationContext): NormalizedNavigationLocation {
  if (context.settingsVisible) {
    if (context.recurringJobsPanel) {
      return { originTab: 'SettingsTab', kind: 'recurringJobs', panel: context.recurringJobsPanel };
    }
    return { originTab: 'SettingsTab', kind: 'settings', category: context.settingsCategory ?? null };
  }

  if (context.folderOverlayVisible) {
    const folder = context.selectedFolder ?? undefined;
    const sessionId = context.activeSessionId ?? undefined;
    const cardId = context.selectedCardId ?? undefined;
    const previousTab = context.previousLocation?.originTab ?? 'DailyTab';
    if (cardId) {
      return sessionId
        ? { originTab: previousTab, kind: 'chat', sessionId, cardId, folder }
        : { originTab: previousTab, kind: 'cardDetail', cardId, folder };
    }
    if (folder) {
      const originTab = context.previousLocation?.originTab ?? 'FolderTab';
      return sessionId
        ? { originTab, kind: 'chat', sessionId, folder, returnTab: originTab === 'DailyTab' ? 'DailyTab' : 'FolderTab' }
        : { originTab, kind: 'folderWorkspace', folder };
    }
    if (sessionId) {
      return { originTab: 'FeedTab', kind: 'chat', sessionId, returnTab: 'FeedTab' };
    }
  }

  if (context.searchActive || context.lastMainFocus === 'search') {
    return {
      originTab: 'FeedTab',
      kind: 'search',
      initialQuery: context.searchQuery || undefined,
    };
  }

  switch (context.lastMainFocus) {
    case 'feed':
      return { originTab: 'FeedTab', kind: 'feed' };
    case 'folder':
      return { originTab: 'FolderTab', kind: 'folderList' };
    case 'dailyHistory':
      return { originTab: 'DailyTab', kind: 'dailyHistory' };
    default:
      return { originTab: 'DailyTab', kind: 'daily' };
  }
}

export function buildPhoneState(location: NormalizedNavigationLocation): InitialState {
  const stacks = new Map<PhoneTabName, RouteSpec[]>([
    ['DailyTab', [{ name: 'Daily' }]],
    ['FolderTab', [{ name: 'FolderList' }]],
    ['PersistentTab', [{ name: 'PersistentSession' }]],
    ['FeedTab', [{ name: 'Feed' }]],
    ['SettingsTab', [{ name: 'Settings' }]],
  ]);
  let activeTab: PhoneTabName = 'DailyTab';

  switch (location.kind) {
    case 'daily':
      activeTab = 'DailyTab';
      stacks.set('DailyTab', [{ name: 'Daily' }]);
      break;
    case 'dailyHistory':
      activeTab = 'DailyTab';
      stacks.set('DailyTab', [{ name: 'Daily' }, { name: 'DailyHistory' }]);
      break;
    case 'folderList':
      activeTab = 'FolderTab';
      break;
    case 'folderWorkspace': {
      activeTab = folderTabOf(location.originTab);
      stacks.set(activeTab, folderStack(activeTab, location.folder));
      break;
    }
    case 'feed':
      activeTab = 'FeedTab';
      break;
    case 'search':
      activeTab = 'FeedTab';
      stacks.set('FeedTab', [
        { name: 'Feed' },
        location.initialQuery === undefined
          ? { name: 'Search' }
          : { name: 'Search', params: { initialQuery: location.initialQuery } },
      ]);
      break;
    case 'chat': {
      activeTab = 'FeedTab';
      const returnTab = location.returnTab ?? (location.folder ? 'FolderTab' : 'FeedTab');
      const cardTab = returnTab === 'FeedTab' ? undefined : returnTab;
      stacks.set('FeedTab', [
        { name: 'Feed' },
        ...(cardTab === undefined && location.cardId ? [{ name: 'CardDetail', params: { cardId: location.cardId } }] : []),
        { name: 'Chat', params: chatParams(location, returnTab) },
      ]);
      if (location.folder) {
        const folderTab = folderTabOf(returnTab);
        stacks.set(folderTab, folderStack(folderTab, location.folder));
      }
      if (cardTab && location.cardId) {
        const base = stacks.get(cardTab) ?? [];
        stacks.set(cardTab, [...base, { name: 'CardDetail', params: { cardId: location.cardId } }]);
      }
      break;
    }
    case 'cardDetail': {
      const pasCard = location.pasCard || location.originTab === 'PersistentTab';
      activeTab = pasCard ? 'PersistentTab' : dayOrPasTab(location.originTab);
      const routes: RouteSpec[] = [baseRoute(activeTab)];
      if (!pasCard && location.folder && (activeTab === 'DailyTab' || activeTab === 'FolderTab')) {
        routes.push({ name: 'FolderWorkspace', params: folderParams(location.folder) });
      }
      routes.push({ name: 'CardDetail', params: { cardId: location.cardId } });
      stacks.set(activeTab, routes);
      break;
    }
    case 'persistentSession':
      activeTab = 'PersistentTab';
      break;
    case 'markdownDocument': {
      const fromPersistent = location.fromPersistent || location.originTab === 'PersistentTab';
      activeTab = fromPersistent ? 'PersistentTab' : dayOrPasTab(location.originTab);
      const routes: RouteSpec[] = [baseRoute(activeTab)];
      if (!fromPersistent && location.folder && (activeTab === 'DailyTab' || activeTab === 'FolderTab')) {
        routes.push({ name: 'FolderWorkspace', params: folderParams(location.folder) });
      }
      if (!fromPersistent && location.cardId) {
        routes.push({ name: 'CardDetail', params: { cardId: location.cardId } });
      }
      routes.push({ name: 'MarkdownDocument', params: { documentId: location.documentId } });
      stacks.set(activeTab, routes);
      break;
    }
    case 'settings':
      activeTab = 'SettingsTab';
      break;
    case 'recurringJobs': {
      activeTab = 'SettingsTab';
      stacks.set('SettingsTab', recurringJobRoutes(location.panel));
      break;
    }
  }

  return {
    type: 'tab',
    key: 'phone-tabs',
    index: PHONE_TABS.indexOf(activeTab),
    routes: PHONE_TABS.map(tab => ({
      key: `phone-${tab}`,
      name: tab,
      state: stackState(tab, stacks.get(tab) ?? []),
    })),
  } as unknown as InitialState;
}

function baseRoute(tab: PhoneTabName): RouteSpec {
  switch (tab) {
    case 'FolderTab':
      return { name: 'FolderList' };
    case 'FeedTab':
      return { name: 'Feed' };
    case 'PersistentTab':
      return { name: 'PersistentSession' };
    case 'SettingsTab':
      return { name: 'Settings' };
    default:
      return { name: 'Daily' };
  }
}

function folderTabOf(originTab: PhoneTabName): PhoneTabName {
  return originTab === 'DailyTab' ? 'DailyTab' : 'FolderTab';
}

function dayOrPasTab(originTab: PhoneTabName): PhoneTabName {
  if (originTab === 'FeedTab' || originTab === 'PersistentTab') return originTab;
  return originTab === 'FolderTab' ? 'FolderTab' : 'DailyTab';
}

function folderStack(tab: PhoneTabName, folder: FolderWorkspaceContext): RouteSpec[] {
  return [baseRoute(tab), { name: 'FolderWorkspace', params: folderParams(folder) }];
}

function folderParams(folder: FolderWorkspaceContext): Record<string, unknown> {
  return folder.folderId === undefined
    ? { folderPageId: folder.folderPageId, folderTitle: folder.folderTitle }
    : { folderPageId: folder.folderPageId, folderTitle: folder.folderTitle, folderId: folder.folderId };
}

function chatParams(
  location: Extract<NormalizedNavigationLocation, { kind: 'chat' }>,
  returnTab: PhoneReturnTab,
): Record<string, unknown> {
  return {
    ...(location.sessionId ? { sessionId: location.sessionId } : {}),
    ...(location.focusEventId === undefined ? {} : { focusEventId: location.focusEventId }),
    ...(location.storyOpenRequestId === undefined ? {} : { storyOpenRequestId: location.storyOpenRequestId }),
    ...(location.usageEntry === undefined ? {} : { usageEntry: location.usageEntry }),
    returnTab,
  };
}

function recurringJobRoutes(panel: RecurringJobsPanelState): RouteSpec[] {
  const routes: RouteSpec[] = [{ name: 'Settings' }, { name: 'RecurringJobs' }];
  if (panel.kind === 'editor') {
    routes.push({
      name: 'RecurringJobEditor',
      ...(panel.jobId === undefined ? {} : { params: { jobId: panel.jobId } }),
    });
  } else if (panel.kind === 'history') {
    routes.push({ name: 'RecurringJobHistory', params: { jobId: panel.jobId } });
  }
  return routes;
}

function stackState(tab: PhoneTabName, routes: RouteSpec[]): Record<string, unknown> {
  return {
    type: 'stack',
    key: `stack-${tab}`,
    index: routes.length - 1,
    routes: routes.map((route, index) => ({
      key: `route-${tab}-${index}`,
      name: route.name,
      ...(route.params === undefined ? {} : { params: route.params }),
    })),
  };
}

export function buildTabletState(location: NormalizedNavigationLocation): {
  initialState: InitialState;
  tabletEffects: TabletContinuityEffects;
} {
  const main = (tabletEffects: TabletContinuityEffects) => ({
    initialState: tabletStack(['Main']),
    tabletEffects,
  });

  switch (location.kind) {
    case 'daily':
      return main({ activeSectionKind: 'daily', lastMainFocus: 'cards' });
    case 'dailyHistory':
      return main({ activeSectionKind: 'daily', lastMainFocus: 'dailyHistory' });
    case 'folderList':
      return main({ lastMainFocus: 'folder' });
    case 'folderWorkspace':
      return main({
        lastMainFocus: 'folder',
        folderOverlay: {
          ...location.folder,
          folderId: location.folder.folderId ?? null,
          sessionId: null,
        },
      });
    case 'feed':
      return main({ lastMainFocus: 'feed' });
    case 'search':
      return main({
        lastMainFocus: 'search',
        searchActive: true,
        searchQuery: location.initialQuery ?? '',
      });
    case 'chat':
      if (location.folder) {
        return main({
          lastMainFocus: 'folder',
          folderOverlay: {
            ...location.folder,
            folderId: location.folder.folderId ?? null,
            sessionId: location.sessionId,
          },
        });
      }
      if (location.cardId) {
        return main({
          lastMainFocus: 'cards',
          cardOverlay: { cardId: location.cardId, sessionId: location.sessionId },
        });
      }
      return main({
        lastMainFocus: 'feed',
        sessionOverlay: {
          sessionId: location.sessionId,
          focusEventId: location.focusEventId,
          storyOpenRequestId: location.storyOpenRequestId,
        },
      });
    case 'cardDetail': {
      const pasCard = location.pasCard || location.originTab === 'PersistentTab';
      if (pasCard) {
        return {
          initialState: tabletStack(['Main', 'PersistentSession']),
          tabletEffects: { lastMainFocus: 'cards', pasSelectedCardId: location.cardId },
        };
      }
      return main({
        lastMainFocus: location.originTab === 'FeedTab' ? 'feed' : location.originTab === 'FolderTab' ? 'folder' : 'cards',
        cardOverlay: { cardId: location.cardId, sessionId: null },
      });
    }
    case 'persistentSession':
      return {
        initialState: tabletStack(['Main', 'PersistentSession']),
        tabletEffects: { pasSelectedCardId: null },
      };
    case 'markdownDocument': {
      const fromPersistent = location.fromPersistent || location.originTab === 'PersistentTab';
      return {
        initialState: tabletStack(
          fromPersistent ? ['Main', 'PersistentSession', 'MarkdownDocument'] : ['Main', 'MarkdownDocument'],
          { documentId: location.documentId },
        ),
        tabletEffects: { lastMainFocus: 'cards' },
      };
    }
    case 'settings':
      return main({
        settingsVisible: true,
        settingsCategory: location.category ?? null,
      });
    case 'recurringJobs':
      return main({
        settingsVisible: true,
        settingsCategory: RECURRING_JOBS_CATEGORY,
        recurringJobsPanel: location.panel,
      });
  }
}

function tabletStack(names: string[], topParams?: Record<string, unknown>): InitialState {
  return {
    type: 'stack',
    key: 'tablet-stack',
    index: names.length - 1,
    routes: names.map((name, index) => ({
      key: `tablet-${index}-${name}`,
      name,
      ...(index === names.length - 1 && topParams !== undefined ? { params: topParams } : {}),
    })),
  } as unknown as InitialState;
}
