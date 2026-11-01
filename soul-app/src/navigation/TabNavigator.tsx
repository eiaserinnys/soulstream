import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import {
  type BottomTabBarButtonProps,
  type BottomTabBarProps,
  createBottomTabNavigator,
  type BottomTabNavigationProp,
  type BottomTabScreenProps,
} from '@react-navigation/bottom-tabs';
import { getDefaultHeaderHeight, PlatformPressable } from '@react-navigation/elements';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  CommonActions,
  useFocusEffect,
  useIsFocused,
  type CompositeScreenProps,
  type NavigatorScreenParams,
} from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  DailyPlannerScreen,
  type DailyPlannerScreenHandle,
} from '../screens/DailyPlannerScreen';
import { FolderListScreen, type FolderListTab } from '../screens/FolderListScreen';
import { ProjectHeaderAddButton, useCreateProject } from '../screens/ProjectListScreen';
import { SessionFeedScreen } from '../screens/SessionFeedScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { RecurringJobsScreen } from '../screens/RecurringJobsScreen';
import { RecurringJobEditorScreen } from '../screens/RecurringJobEditorScreen';
import { RecurringJobHistoryScreen } from '../screens/RecurringJobHistoryScreen';
import { useSessionsStream } from '../hooks/useSessionsStream';
import { useNodeConnectivityStream } from '../hooks/useNodeConnectivityStream';
import { GlassSurface } from '../components/GlassSurface';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens, type DesignTokens } from '../theme';
import { DuoSideBandContext, DUO_RAIL_TAB_ORDER, INITIAL_ROOT_TAB, PhoneRailModeContext, RAIL_MIN_INSET_WIDTH, ROOT_TAB_ORDER } from './tabContract';
import { DUO_RAIL_END_INSET, getDuoRailTopOffset, hasDuoSideBand, splitDuoRailBackAction, useDuoSideBand } from './duoSideBand';
import { useActiveDuoRailOverride, usePhoneRailActions, useRegisterDuoRailOverride, useRegisterPhoneRailActions, type PhoneRailAction } from './phoneRailActions';
import { RAIL_CAPSULE_WIDTH, RAIL_ITEM_HEIGHT, RailCapsule, RailCapsuleItem, RailCapsuleViewport } from '../components/navigation/RailCapsule';
import { usePasContextMenu } from '../components/persistent/usePasContextMenu';
import { FolderWorkspace } from '../components/planner/FolderWorkspace';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import { openPhoneChat, openPhoneSearchSession } from './phoneSessionNavigation';
import { useSearchStore } from '../store/searchStore';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PhoneCardDetail, PhoneMarkdownDocument, getDefaultTabBarStyle, type MarkdownDocumentRouteParams } from './PhoneContentScreens';
import { PhonePersistentSession, PersistentPhoneTabIcon } from './PhonePersistentSession';
import { usePersistentSessionHost, usePersistentSessionScene } from './PersistentSessionContext';
import type { PhoneReturnTab } from './phonePanelHistory';
import { ROOT_SECTION_CONFIG, type RootSectionKey } from './rootSectionConfig';
import { RootSectionHeaderTitle } from '../components/navigation/RootSectionHeaderTitle';
import { DailyHeaderActions } from '../components/planner/DailyHeaderActions';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { PhoneCardHome } from './PhoneCardHome';
import { DuoSafeTop } from './DuoSafeTop';
import {
  PhonePanelHistoryProvider,
  usePhonePanelHistory,
} from './phonePanelHistory';

export { INITIAL_ROOT_TAB, ROOT_TAB_ORDER } from './tabContract';
export { RAIL_MIN_INSET_WIDTH } from './tabContract';

export { PhoneCardDetail, getDefaultTabBarStyle } from './PhoneContentScreens';

function TabBarGlassBackground() {
  return (
    <GlassSurface
      role="chrome"
      style={StyleSheet.absoluteFill}
    />
  );
}

const PHONE_TAB_BUTTON_CENTER_STYLE: ViewStyle = { justifyContent: 'center' };

/** 우측 시스템 레일이 생기는 최소 안전 영역 폭. 듀오 바깥 화면은 84pt다. */

/**
 * 아이폰 듀오 바깥 화면처럼 오른쪽에 시스템 레일이 있는 환경의 세로 탭 클러스터.
 * 하단 탭바 대신 같은 5개 루트 탭을 유리 캡슐에 담아 레일 하단에 둔다.
 */
export function PhoneRailTabCluster({ active, onSelect, duoSideBand = false, compact = false, onBack }: {
  active: keyof RootTabParamList;
  onSelect(name: keyof RootTabParamList): void;
  duoSideBand?: boolean;
  compact?: boolean;
  onBack?: () => void;
}) {
  const t = useTokens();
  const c = t.colors;
  const scene = usePersistentSessionScene(state => state.scene);
  const hasMultiplePas = usePersistentSessionScene(state => state.sessions.length > 1);
  const selectedCardId = usePersistentSessionScene(state => state.selectedCardId);
  const reportCount = usePersistentSessionScene(state => state.reportCount);
  const hasReports = usePersistentSessionScene(state => state.hasReports);
  const host = usePersistentSessionHost();
  const showPasMenu = usePasContextMenu();
  const actions = usePhoneRailActions(state => state.actions);
  const override = useActiveDuoRailOverride();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { backAction, mainActions } = splitDuoRailBackAction(duoSideBand ? override : null);
  const topOffset = getDuoRailTopOffset(windowWidth, windowHeight);
  const renderOverrideAction = (action: PhoneRailAction) => <RailCapsuleItem key={action.id} testID={`phone-rail-action-${action.id}`}
    label={action.label} selected={action.selected} badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
    <Ionicons name={action.icon} color={action.selected ? c.accent : c.textMuted} size={t.iconSize.standard} />
  </RailCapsuleItem>;
  const persistentLabel = active !== 'PersistentTab'
    ? '영구 세션 열기'
    : (duoSideBand || hasMultiplePas) ? '영구 세션 선택' : scene !== 'conversation' ? 'PAS 대화로 돌아가기' : '카드 목록 보기';
  const renderTab = (name: keyof RootTabParamList) => {
    const config = ROOT_SECTION_CONFIG[name];
    const selected = name === active;
    const color = selected ? c.accent : c.textMuted;
    return <RailCapsuleItem key={name} testID={`phone-tab-${name}`} role="tab"
      label={name === 'PersistentTab' ? persistentLabel : config.title} selected={selected} onPress={() => onSelect(name)}>
      {name === 'PersistentTab'
        ? <PersistentPhoneTabIcon color={color} size={t.iconSize.standard} active={selected} />
        : <Ionicons name={config.icon} color={color} size={t.iconSize.standard} />}
    </RailCapsuleItem>;
  };

  if (!duoSideBand) {
    return <RailCapsule testID="phone-rail-tab-cluster" compact={compact}>
      {ROOT_TAB_ORDER.map((name) => renderTab(name))}
    </RailCapsule>;
  }

  const defaultBackAction: PhoneRailAction = active === 'PersistentTab'
    ? selectedCardId
      ? { id: 'back', label: '카드 닫기', icon: 'chevron-back', onPress: () => host.store.getState().selectCard(null) }
      : scene !== 'conversation'
        ? { id: 'back', label: 'PAS 대화로 돌아가기', icon: 'chevron-back', onPress: () => host.store.getState().swipe('right') }
        : { id: 'back', label: '뒤로', icon: 'chevron-back', disabled: !onBack && !host.store.getState().session,
            onPress: () => { if (onBack) onBack(); else host.store.getState().leave(); } }
    : { id: 'back', label: '뒤로', icon: 'chevron-back', disabled: !onBack, onPress: () => onBack?.() };
  const resolvedBackAction = backAction ?? defaultBackAction;
  const contextActions: PhoneRailAction[] = override?.length
    ? mainActions
    : active === 'PersistentTab'
      ? [
        { id: 'pas-menu', label: 'PAS 메뉴', icon: 'ellipsis-horizontal', onPress: showPasMenu },
        { id: 'pas-reports', label: !hasReports ? '지금의 보고 없음' : scene === 'reports' ? 'PAS 대화로 돌아가기' : '지금의 보고',
          icon: 'chatbubble-ellipses-outline', selected: scene === 'reports', badgeCount: reportCount, disabled: !hasReports,
          onPress: () => host.store.getState().toggleReports() },
      ]
      : active === 'DailyTab' || active === 'FolderTab' || active === 'FeedTab'
        ? actions[active] ?? []
        : [];
  const navigationNames = DUO_RAIL_TAB_ORDER.filter((name) => name !== active || (name === 'PersistentTab' && hasMultiplePas));
  const navigationItemHeight = compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT;
  const navigationHeight = navigationNames.length * navigationItemHeight
    + (compact ? 0 : Math.max(0, navigationNames.length - 1) * t.uiSpacing.xs / 2)
    + 2 * (compact ? t.spacing.xxs : t.spacing.xs);
  const bottomInset = compact ? insets.bottom : Math.max(insets.bottom, t.uiSpacing.xxl);
  const stackGap = compact ? t.uiSpacing.xs : t.uiSpacing.sm;
  const contextMaxHeight = Math.max(0,
    windowHeight - bottomInset - navigationHeight - topOffset - RAIL_CAPSULE_WIDTH - 2 * stackGap);
  const renderContextAction = (action: PhoneRailAction) => {
    const testID = !override?.length && active === 'PersistentTab'
      ? action.id === 'pas-menu' ? 'phone-rail-pas-menu' : 'phone-rail-pas-reports'
      : `phone-rail-action-${action.id}`;
    return <RailCapsuleItem key={action.id} testID={testID} label={action.label} selected={action.selected}
      badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
      <Ionicons name={action.icon} color={action.selected ? c.accent : c.textMuted} size={t.iconSize.standard} />
    </RailCapsuleItem>;
  };

  return <View testID="duo-rail-column" style={{ width: RAIL_CAPSULE_WIDTH, flex: 1, position: 'relative', alignItems: 'center', justifyContent: 'flex-end' }}>
    <View testID="duo-rail-top-stack" pointerEvents="box-none"
      style={{ position: 'absolute', top: topOffset, left: 0, right: 0, alignItems: 'center', gap: stackGap }}>
      <RailCapsule testID="duo-rail-back-capsule" compact={compact}>{renderOverrideAction(resolvedBackAction)}</RailCapsule>
      {contextActions.length ? <RailCapsuleViewport testID="duo-rail-context-scroll" maxHeight={contextMaxHeight}>
        <RailCapsule testID="duo-rail-context-capsule" compact={compact}>{contextActions.map(renderContextAction)}</RailCapsule>
      </RailCapsuleViewport> : null}
    </View>
    <RailCapsule testID="phone-rail-tab-cluster" compact={compact}>
      {navigationNames.map((name) => renderTab(name))}
    </RailCapsule>
  </View>;
}

function PhoneRailTabBar({ state, descriptors, navigation, insets, duoSideBand }: BottomTabBarProps & { duoSideBand: boolean }) {
  const t = useTokens();
  const panelHistory = usePhonePanelHistory();
  const host = usePersistentSessionHost();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const activeRoute = state.routes[state.index];
  const active = activeRoute?.name as keyof RootTabParamList;
  const nestedState = (activeRoute as typeof activeRoute & {
    state?: { index?: number; routes?: Array<{ name?: string }> };
  } | undefined)?.state;
  const nestedRouteName = nestedState?.routes?.[nestedState.index ?? 0]?.name;
  const rootWithoutHeader = duoSideBand && (
    (active === 'DailyTab' && (!nestedRouteName || nestedRouteName === 'Daily'))
    || (active === 'FolderTab' && (!nestedRouteName || nestedRouteName === 'FolderList'))
    || (active === 'FeedTab' && (!nestedRouteName || nestedRouteName === 'Feed'))
  );
  const showHeaderCap = !duoSideBand && !rootWithoutHeader && (active === 'SettingsTab'
    ? ['RecurringJobs', 'RecurringJobEditor', 'RecurringJobHistory'].includes(nestedRouteName ?? '')
    : active === 'DailyTab' || active === 'FolderTab' || active === 'FeedTab'
      ? nestedRouteName !== 'CardDetail' && nestedRouteName !== 'MarkdownDocument'
      : false);
  const compact = duoSideBand && windowWidth > windowHeight;
  // 하위 화면이 탭바를 숨기면 레일 열 폭은 유지하고 캡슐만 감춘다.
  const hidden = !duoSideBand && StyleSheet.flatten(
    (activeRoute ? descriptors[activeRoute.key]?.options?.tabBarStyle : undefined) as ViewStyle | undefined,
  )?.display === 'none';
  const select = (name: keyof RootTabParamList) => {
    const route = state.routes.find((item) => item.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!event.defaultPrevented && name !== active) {
      navigation.dispatch({ ...CommonActions.navigate(name), target: state.key });
    }
  };
  const canGoBack = (nestedState?.index ?? 0) > 0
    || (panelHistory.hasReturnTab() && panelHistory.getReturnTab() !== active)
    || active !== INITIAL_ROOT_TAB;
  const onBack = useCallback(() => {
    if ((nestedState?.index ?? 0) > 0) {
      navigation.dispatch(CommonActions.goBack());
      return;
    }
    if (panelHistory.hasReturnTab()) {
      const returnTab = panelHistory.getReturnTab();
      if (returnTab !== active) {
        if (active === 'PersistentTab') host.store.getState().leave();
        select(returnTab);
        return;
      }
    }
    if (active !== INITIAL_ROOT_TAB) {
      if (active === 'PersistentTab') host.store.getState().leave();
      select(INITIAL_ROOT_TAB);
    }
  }, [active, host.store, navigation, nestedState?.index, panelHistory, select]);
  return <View
    testID="phone-rail-tab-rail"
    style={{
      position: 'relative',
      width: Math.max(insets.right, RAIL_MIN_INSET_WIDTH),
      paddingBottom: compact ? insets.bottom : Math.max(insets.bottom, t.uiSpacing.xxl),
      alignItems: 'center',
      justifyContent: 'flex-end',
      ...(duoSideBand ? { paddingRight: DUO_RAIL_END_INSET } : {}),
    }}
  >
    {showHeaderCap ? <View
      testID="phone-rail-header-cap"
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: getDefaultHeaderHeight(
          { width: Math.max(0, windowWidth - insets.left - insets.right), height: windowHeight },
          false,
          insets.top,
        ),
        backgroundColor: createSurfaceRoles(t).chrome.tokenStyle.backgroundColor,
      }}
    /> : null}
    {hidden ? null : <PhoneRailTabCluster active={active} onSelect={select} duoSideBand={duoSideBand} compact={compact}
      onBack={duoSideBand && canGoBack ? onBack : undefined} />}
  </View>;
}

function CenteredPhoneTabButton(props: BottomTabBarButtonProps) {
  return (
    <PlatformPressable
      {...props}
      style={[props.style, PHONE_TAB_BUTTON_CENTER_STYLE]}
    />
  );
}

export type RootTabParamList = {
  DailyTab: undefined;
  FolderTab: NavigatorScreenParams<FolderStackParamList> | undefined;
  FeedTab: NavigatorScreenParams<FeedStackParamList> | undefined;
  PersistentTab: NavigatorScreenParams<PersistentStackParamList> | undefined;
  SettingsTab: undefined;
};

export type DailyStackParamList = {
  Daily: undefined;
  DailyHistory: undefined;
  FolderWorkspace: { folderPageId: string; folderTitle: string; folderId?: string };
  CardDetail: { cardId: string };
  MarkdownDocument: MarkdownDocumentRouteParams;
};
export type FolderStackParamList = {
  FolderList: undefined;
  FolderWorkspace: { folderPageId: string; folderTitle: string; folderId?: string };
  CardDetail: { cardId: string };
  MarkdownDocument: MarkdownDocumentRouteParams;
};
export type FeedStackParamList = {
  Feed: undefined;
  Search: { initialQuery?: string } | undefined;
  Chat: {
    sessionId?: string;
    focusEventId?: number;
    storyOpenRequestId?: number;
    usageEntry?: 'notification';
    returnTab?: PhoneReturnTab;
  } | undefined;
  CardDetail: { cardId: string };
  MarkdownDocument: MarkdownDocumentRouteParams;
};
export type PersistentStackParamList = {
  PersistentSession: undefined;
  CardDetail: { cardId: string };
  MarkdownDocument: MarkdownDocumentRouteParams;
};
export type SettingsStackParamList = {
  Settings: undefined;
  RecurringJobs: undefined;
  RecurringJobEditor: { jobId?: string } | undefined;
  RecurringJobHistory: { jobId: string };
};

const DailyStack = createNativeStackNavigator<DailyStackParamList>();
const FolderStack = createNativeStackNavigator<FolderStackParamList>();
const FeedStack = createNativeStackNavigator<FeedStackParamList>();
const PersistentStack = createNativeStackNavigator<PersistentStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function stackScreenOptions(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  return {
    headerStyle: {
      backgroundColor: roles.chrome.tokenStyle.backgroundColor as string,
    },
    headerTintColor: t.colors.textPrimary,
    headerShadowVisible: false,
    contentStyle: roles.canvas.tokenStyle,
  };
}

function rootScreenOptions(section: RootSectionKey) {
  const config = ROOT_SECTION_CONFIG[section];
  return {
    title: config.title,
    headerTitleAlign: 'left' as const,
    headerTitle: () => <RootSectionHeaderTitle section={section} />,
  };
}

function PhoneDailyHistoryScreen({ navigation }: NativeStackScreenProps<DailyStackParamList, 'DailyHistory'>) {
  const dailyRef = useRef<DailyPlannerScreenHandle>(null);
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  useRegisterDuoRailOverride('daily-history', duo && focused, [
    { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() },
    { id: 'folder-add', label: '폴더 추가', icon: 'add', onPress: () => dailyRef.current?.openNewFolder() },
    { id: 'review', label: '모닝 리뷰', icon: 'sunny-outline', onPress: () => dailyRef.current?.openReview() },
  ]);
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <DailyHeaderActions
          onOpenReview={() => dailyRef.current?.openReview()}
          onOpenNewFolder={() => dailyRef.current?.openNewFolder()}
        />
      ),
    });
  }, [navigation]);
  return (
    <DuoSafeTop><DailyPlannerScreen
      ref={dailyRef}
      active={focused}
      onOpenSession={(id) => openPhoneChat(navigation, id)}
      onOpenFolder={(folder) => navigation.navigate('FolderWorkspace', {
        folderPageId: folder.page.id,
        folderTitle: folder.page.title,
        folderId: folder.folderId,
      })}
    /></DuoSafeTop>
  );
}

function PhoneDailyFolderWorkspace({ route, navigation }: NativeStackScreenProps<DailyStackParamList, 'FolderWorkspace'>) {
  return <PhoneFolderWorkspace folderPageId={route.params.folderPageId} folderId={route.params.folderId} navigation={navigation} />;
}

function DailyNavigator() {
  const t = useTokens();
  const duo = useDuoSideBand();
  return (
    <DailyStack.Navigator screenOptions={stackScreenOptions(t)}>
      <DailyStack.Screen name="Daily" component={PhoneCardHome} options={{ ...rootScreenOptions('DailyTab'), headerShown: !duo }} />
      <DailyStack.Screen name="DailyHistory" component={PhoneDailyHistoryScreen} options={{ title: '데일리 기록', headerShown: !duo }} />
      <DailyStack.Screen
        name="FolderWorkspace"
        component={PhoneDailyFolderWorkspace}
        options={({ route }) => ({ title: route.params.folderTitle, headerShown: !duo })}
      />
      <DailyStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드', headerShown: false }} />
      <DailyStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} options={{ headerShown: false }} />
    </DailyStack.Navigator>
  );
}

function PhoneFolderListScreen({ navigation }: NativeStackScreenProps<FolderStackParamList, 'FolderList'>) {
  const duo = useDuoSideBand();
  const [tab, setTab] = useState<FolderListTab>('starred');
  const createProject = useCreateProject();
  const railActions = useMemo<PhoneRailAction[]>(() => [
    { id: 'starred', label: '중요 작업', icon: 'star-outline', selected: tab === 'starred', onPress: () => setTab('starred') },
    { id: 'all-folders', label: '전체 폴더', icon: 'folder-outline', selected: tab === 'all', onPress: () => setTab('all') },
    ...(tab === 'all' ? [{ id: 'project-create', label: '새 프로젝트', icon: 'add' as const, onPress: createProject }] : []),
  ], [tab, createProject]);
  useRegisterPhoneRailActions('FolderTab', duo, railActions);
  const onTabChange = useCallback((tab: FolderListTab) => {
    setTab(tab);
    navigation.setOptions({ headerRight: () => tab === 'all' ? <ProjectHeaderAddButton /> : null });
  }, [navigation]);
  return <DuoSafeTop><FolderListScreen active={useIsFocused()} selectedTab={duo ? tab : undefined} onTabChange={onTabChange}
    onOpenFolder={(folder) => navigation.navigate('FolderWorkspace', {
      folderPageId: folder.page.id, folderTitle: folder.page.title, folderId: folder.folderId,
    })}
    onOpenProject={(folder, projectPageId) => navigation.navigate('FolderWorkspace', {
      folderPageId: projectPageId, folderTitle: folder.name, folderId: folder.id,
    })} /></DuoSafeTop>;
}

function PhoneFolderListWorkspace({ route, navigation }: NativeStackScreenProps<FolderStackParamList, 'FolderWorkspace'>) {
  return <PhoneFolderWorkspace folderPageId={route.params.folderPageId} folderId={route.params.folderId} navigation={navigation} />;
}

export function PhoneFolderWorkspace({ folderPageId, folderId, navigation }: { folderPageId: string; folderId?: string; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const cardDisplay = useCardDisplay(folderId ?? folderPageId);
  return (
    <DuoSafeTop><FolderWorkspace
      api={api}
      folderPageId={folderPageId}
      folderId={folderId}
      cardDisplay={cardDisplay}
      active={useIsFocused()}
      onClose={() => navigation.goBack()}
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
      onTitleSaved={(folderTitle) => navigation.setParams({ folderTitle: folderTitle })}
      onOpenFolder={(nextFolderId, nextPageId, nextName) => navigation.push('FolderWorkspace', {
        folderPageId: nextPageId,
        folderTitle: nextName,
        folderId: nextFolderId,
      })}
    /></DuoSafeTop>
  );
}

function FolderNavigator() {
  const t = useTokens();
  const duo = useDuoSideBand();
  return (
    <FolderStack.Navigator screenOptions={stackScreenOptions(t)}>
      <FolderStack.Screen
        name="FolderList"
        component={PhoneFolderListScreen}
        options={{ ...rootScreenOptions('FolderTab'), headerShown: !duo }}
      />
      <FolderStack.Screen
        name="FolderWorkspace"
        component={PhoneFolderListWorkspace}
        options={({ route }) => ({ title: route.params.folderTitle, headerShown: !duo })}
      />
      <FolderStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드', headerShown: false }} />
      <FolderStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} options={{ headerShown: false }} />
    </FolderStack.Navigator>
  );
}

type PhoneFeedProps = CompositeScreenProps<
  NativeStackScreenProps<FeedStackParamList, 'Feed'>,
  BottomTabScreenProps<RootTabParamList>
>;

export function PhoneSessionFeedScreen({ navigation }: PhoneFeedProps) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const railActions = useMemo<PhoneRailAction[]>(() => [
    { id: 'search', label: '세션 검색', icon: 'search-outline', onPress: () => navigation.navigate('Search') },
  ], [navigation]);
  useRegisterPhoneRailActions('FeedTab', duo, railActions);
  useLayoutEffect(() => {
    const openSearch = () => navigation.navigate('Search');
    navigation.setOptions?.({
      headerSearchBarOptions: {
        placeholder: '세션 및 대화 검색',
        hideWhenScrolling: true,
        placement: 'stacked',
        allowToolbarIntegration: false,
        onOpen: openSearch,
      },
      headerRight: () => (
        <LiquidGlassButton
          iconOnly
          accessibilityLabel="세션 검색"
          onPress={openSearch}
        >
          <Ionicons
            name="search-outline"
            color={t.colors.textPrimary}
            size={t.iconSize.standard}
          />
        </LiquidGlassButton>
      ),
    });
  }, [navigation, t]);
  return (
    <DuoSafeTop><SessionFeedScreen
      active={useIsFocused()}
      reserveBottomSearchBarSpace={!duo}
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
    /></DuoSafeTop>
  );
}

function PhoneSearchScreen({
  route,
  navigation,
}: NativeStackScreenProps<FeedStackParamList, 'Search'>) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  useRegisterDuoRailOverride('search', duo && focused, [{ id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() }]);
  const tabs = navigation.getParent<BottomTabNavigationProp<RootTabParamList>>();
  useLayoutEffect(() => {
    useSearchStore.getState().setQuery(route.params?.initialQuery ?? '');
  }, [route.params?.initialQuery]);
  useFocusEffect(
    useCallback(() => {
      if (duo) return;
      const tabs = navigation.getParent();
      tabs?.setOptions({
        tabBarStyle: {
          ...getDefaultTabBarStyle(t.colors),
          display: 'none',
        },
      });
      return () => {
        tabs?.setOptions({ tabBarStyle: getDefaultTabBarStyle(t.colors) });
      };
    }, [navigation, t.colors, duo]),
  );
  return (
    <DuoSafeTop><SearchScreen
      onOpenSession={(sessionId, eventId, storyOpenRequestId) =>
        void openPhoneSearchSession(
          navigation,
          sessionId,
          eventId,
          storyOpenRequestId,
        )
      }
      onOpenFolder={(result) =>
        tabs?.navigate('FolderTab', {
          screen: 'FolderWorkspace',
          params: {
            folderPageId: result.projectPageId,
            folderTitle: result.title,
            folderId: result.folderId,
          },
        })
      }
    /></DuoSafeTop>
  );
}

function FeedNavigator() {
  const t = useTokens();
  const duo = useDuoSideBand();
  return (
    <FeedStack.Navigator screenOptions={stackScreenOptions(t)}>
      <FeedStack.Screen name="Feed" component={PhoneSessionFeedScreen} options={{ ...rootScreenOptions('FeedTab'), headerShown: !duo }} />
      <FeedStack.Screen
        name="Search"
        component={PhoneSearchScreen}
        options={{ title: '검색', headerLargeTitleEnabled: false, headerShown: !duo }}
      />
      <FeedStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드', headerShown: false }} />
      <FeedStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} options={{ headerShown: false }} />
      <FeedStack.Screen name="Chat" component={ChatScreen} options={{ ...rootScreenOptions('ChatTab'), gestureEnabled: false, headerShown: !duo }} />
    </FeedStack.Navigator>
  );
}

function PersistentNavigator() {
  const t = useTokens();
  return <PersistentStack.Navigator screenOptions={{ ...stackScreenOptions(t), headerShown: false }}>
    <PersistentStack.Screen name="PersistentSession" component={PhonePersistentSession} />
    <PersistentStack.Screen name="CardDetail" component={PhoneCardDetail} />
    <PersistentStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} />
  </PersistentStack.Navigator>;
}

function SettingsNavigator() {
  const t = useTokens();
  const duo = useDuoSideBand();
  return (
    <SettingsStack.Navigator screenOptions={stackScreenOptions(t)}>
      <SettingsStack.Screen name="Settings" component={PhoneSettingsScreen} options={{ ...rootScreenOptions('SettingsTab'), headerShown: false }} />
      <SettingsStack.Screen name="RecurringJobs" component={RecurringJobsScreen} options={{ title: '반복 작업', headerShown: !duo }} />
      <SettingsStack.Screen name="RecurringJobEditor" component={RecurringJobEditorScreen} options={{ title: '반복 작업 편집', headerShown: !duo }} />
      <SettingsStack.Screen name="RecurringJobHistory" component={RecurringJobHistoryScreen} options={{ title: '실행 이력', headerShown: !duo }} />
    </SettingsStack.Navigator>
  );
}

export function PhoneSettingsScreen({ navigation }: NativeStackScreenProps<SettingsStackParamList, 'Settings'>) {
  return <SettingsScreen active={useIsFocused()} showTitle={false} bottomSafeAreaOwner="parent" />;
}

const Tab = createBottomTabNavigator<RootTabParamList>();

const TAB_COMPONENTS: Record<
  keyof RootTabParamList,
  React.ComponentType<any>
> = {
  DailyTab: DailyNavigator,
  FolderTab: FolderNavigator,
  FeedTab: FeedNavigator,
  // 빌드 26: 키보드 등장 시 탭 바 숨김은 ChatScreen 내부에서 useFocusEffect +
  // Keyboard 리스너로 처리한다. 시작 시점 리스너는 iOS 26.3.1 + RN New Arch에서
  // KeyboardObserver TurboModule race로 부팅 크래시를 일으키므로 다시 추가하지 않는다.
  PersistentTab: PersistentNavigator,
  SettingsTab: SettingsNavigator,
};

export function TabNavigator({ initialTab }: { initialTab?: string } = {}) {
  return (
    <PhonePanelHistoryProvider>
      <PhoneTabNavigator initialTab={initialTab} />
    </PhonePanelHistoryProvider>
  );
}

function PhoneTabNavigator({ initialTab }: { initialTab?: string }) {
  useSessionsStream();
  useNodeConnectivityStream();
  const panelHistory = usePhonePanelHistory();
  const host = usePersistentSessionHost();
  const scene = usePersistentSessionScene(state => state.scene);
  const hasMultiplePas = usePersistentSessionScene(state => state.sessions.length > 1);
  const restoredTab = ROOT_TAB_ORDER.find(name => name === initialTab);
  const [focusedTab, setFocusedTab] = useState<keyof RootTabParamList>(restoredTab ?? (host.store.getState().visible ? 'PersistentTab' : INITIAL_ROOT_TAB));
  const t = useTokens();
  const c = t.colors;
  const insets = useSafeAreaInsets();
  const railMode = insets.right >= RAIL_MIN_INSET_WIDTH;
  const outerDuoSideBand = React.useContext(DuoSideBandContext);
  const duoSideBand = outerDuoSideBand ?? hasDuoSideBand(insets);
  return (
    <Tab.Navigator
      tabBar={railMode ? (props) => <PhoneRailTabBar {...props} duoSideBand={duoSideBand} /> : undefined}
      screenLayout={({ children }) => (
        <PhoneRailModeContext.Provider value={railMode}>
          <DuoSideBandContext.Provider value={duoSideBand}>
          <SafeAreaInsetsContext.Provider value={railMode ? { ...insets, right: 0 } : insets}>
            {children}
          </SafeAreaInsetsContext.Provider>
          </DuoSideBandContext.Provider>
        </PhoneRailModeContext.Provider>
      )}
      initialRouteName={restoredTab ?? (host.store.getState().visible ? 'PersistentTab' : INITIAL_ROOT_TAB)}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
        tabBarShowLabel: false,
        tabBarPosition: railMode ? 'right' : 'bottom',
        tabBarButton: CenteredPhoneTabButton,
        tabBarStyle: getDefaultTabBarStyle(c),
        tabBarBackground: () => <TabBarGlassBackground />,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textMuted,
        animation: 'none',
      }}
    >
      {ROOT_TAB_ORDER.map((name) => {
        const config = ROOT_SECTION_CONFIG[name];
        return (
          <Tab.Screen
            key={name}
            name={name}
            component={TAB_COMPONENTS[name]}
            listeners={({ navigation }) => ({ focus: () => { panelHistory.recordFocus(name); setFocusedTab(name); host.store.setState({ visible: name === 'PersistentTab' }); },
              ...(name === 'PersistentTab' ? { tabPress: (event: { preventDefault(): void }) => {
                event.preventDefault();
                if (navigation.isFocused() && host.store.getState().session) {
                  if (duoSideBand || host.store.getState().sessions.length > 1) {
                    void host.requestEntry(() => navigation.navigate('PersistentTab'), false, true);
                  } else {
                    host.store.getState().toggleScene();
                  }
                } else {
                  void host.requestEntry(() => navigation.navigate('PersistentTab'));
                }
              } } : {}),
            })}
            options={{
              tabBarButtonTestID: `phone-tab-${name}`,
              ...(name === 'PersistentTab' ? { tabBarAccessibilityLabel: focusedTab === 'PersistentTab'
                ? (duoSideBand || hasMultiplePas) ? '영구 세션 선택' : scene !== 'conversation' ? 'PAS 대화로 돌아가기' : '카드 목록 보기'
                : '영구 세션 열기' } : {}),
              tabBarIcon: ({ color, size }) => name === 'PersistentTab'
                ? <PersistentPhoneTabIcon color={color} size={size} active={focusedTab === name} />
                : <Ionicons name={config.icon} color={color} size={size} />,
            }}
          />
        );
      })}
    </Tab.Navigator>
  );
}
