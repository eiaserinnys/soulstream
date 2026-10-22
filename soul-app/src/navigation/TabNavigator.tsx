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
import { ProjectHeaderAddButton } from '../screens/ProjectListScreen';
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
import { INITIAL_ROOT_TAB, PhoneRailModeContext, ROOT_TAB_ORDER } from './tabContract';
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
import {
  PhonePanelHistoryProvider,
  usePhonePanelHistory,
} from './phonePanelHistory';

export { INITIAL_ROOT_TAB, ROOT_TAB_ORDER } from './tabContract';

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
export const RAIL_MIN_INSET_WIDTH = 48;
const RAIL_CAPSULE_WIDTH = 48;
const RAIL_ITEM_HEIGHT = 50;

/**
 * 아이폰 듀오 바깥 화면처럼 오른쪽에 시스템 레일이 있는 환경의 세로 탭 클러스터.
 * 하단 탭바 대신 같은 5개 루트 탭을 유리 캡슐에 담아 레일 하단에 둔다.
 */
export function PhoneRailTabCluster({ active, onSelect }: {
  active: keyof RootTabParamList;
  onSelect(name: keyof RootTabParamList): void;
}) {
  const t = useTokens();
  const c = t.colors;
  const scene = usePersistentSessionScene(state => state.scene);
  const persistentLabel = active !== 'PersistentTab'
    ? '영구 세션 열기'
    : scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기';
  return <GlassSurface role="chrome" testID="phone-rail-tab-cluster" cornerRadius={t.foundation.radius.round}
    style={{ width: RAIL_CAPSULE_WIDTH }}>
    <View style={{ width: RAIL_CAPSULE_WIDTH, paddingVertical: t.spacing.xs, gap: t.uiSpacing.xs / 2, alignItems: 'center' }}>
      {ROOT_TAB_ORDER.map((name) => {
        const config = ROOT_SECTION_CONFIG[name];
        const selected = name === active;
        const color = selected ? c.accent : c.textMuted;
        return <PlatformPressable
          key={name}
          testID={`phone-tab-${name}`}
          accessibilityRole="tab"
          accessibilityLabel={name === 'PersistentTab' ? persistentLabel : config.title}
          accessibilityState={{ selected }}
          onPress={() => onSelect(name)}
          style={{
            width: RAIL_CAPSULE_WIDTH - 4,
            height: RAIL_ITEM_HEIGHT,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {name === 'PersistentTab'
            ? <PersistentPhoneTabIcon color={color} size={t.iconSize.standard} active={selected} />
            : <Ionicons name={config.icon} color={color} size={t.iconSize.standard} />}
        </PlatformPressable>;
      })}
    </View>
  </GlassSurface>;
}

function PhoneRailTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const t = useTokens();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const activeRoute = state.routes[state.index];
  const active = activeRoute?.name as keyof RootTabParamList;
  const nestedState = (activeRoute as typeof activeRoute & {
    state?: { index?: number; routes?: Array<{ name?: string }> };
  } | undefined)?.state;
  const nestedRouteName = nestedState?.routes?.[nestedState.index ?? 0]?.name;
  const showHeaderCap = active === 'SettingsTab'
    ? ['RecurringJobs', 'RecurringJobEditor', 'RecurringJobHistory'].includes(nestedRouteName ?? '')
    : active === 'DailyTab' || active === 'FolderTab' || active === 'FeedTab'
      ? nestedRouteName !== 'CardDetail' && nestedRouteName !== 'MarkdownDocument'
      : false;
  // 하위 화면이 탭바를 숨기면 레일 열 폭은 유지하고 캡슐만 감춘다.
  const hidden = StyleSheet.flatten(
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
  return <View
    testID="phone-rail-tab-rail"
    style={{
      position: 'relative',
      width: Math.max(insets.right, RAIL_MIN_INSET_WIDTH),
      paddingBottom: Math.max(insets.bottom, t.uiSpacing.xxl),
      alignItems: 'center',
      justifyContent: 'flex-end',
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
    {hidden ? null : <PhoneRailTabCluster active={active} onSelect={select} />}
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
    <DailyPlannerScreen
      ref={dailyRef}
      active={useIsFocused()}
      onOpenSession={(id) => openPhoneChat(navigation, id)}
      onOpenFolder={(folder) => navigation.navigate('FolderWorkspace', {
        folderPageId: folder.page.id,
        folderTitle: folder.page.title,
        folderId: folder.folderId,
      })}
    />
  );
}

function PhoneDailyFolderWorkspace({ route, navigation }: NativeStackScreenProps<DailyStackParamList, 'FolderWorkspace'>) {
  return <PhoneFolderWorkspace folderPageId={route.params.folderPageId} folderId={route.params.folderId} navigation={navigation} />;
}

function DailyNavigator() {
  const t = useTokens();
  return (
    <DailyStack.Navigator screenOptions={stackScreenOptions(t)}>
      <DailyStack.Screen name="Daily" component={PhoneCardHome} options={rootScreenOptions('DailyTab')} />
      <DailyStack.Screen name="DailyHistory" component={PhoneDailyHistoryScreen} options={{ title: '데일리 기록' }} />
      <DailyStack.Screen
        name="FolderWorkspace"
        component={PhoneDailyFolderWorkspace}
        options={({ route }) => ({ title: route.params.folderTitle })}
      />
      <DailyStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드', headerShown: false }} />
      <DailyStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} options={{ headerShown: false }} />
    </DailyStack.Navigator>
  );
}

function PhoneFolderListScreen({ navigation }: NativeStackScreenProps<FolderStackParamList, 'FolderList'>) {
  const onTabChange = useCallback((tab: FolderListTab) => {
    navigation.setOptions({ headerRight: () => tab === 'all' ? <ProjectHeaderAddButton /> : null });
  }, [navigation]);
  return <FolderListScreen active={useIsFocused()} onTabChange={onTabChange}
    onOpenFolder={(folder) => navigation.navigate('FolderWorkspace', {
      folderPageId: folder.page.id, folderTitle: folder.page.title, folderId: folder.folderId,
    })}
    onOpenProject={(folder, projectPageId) => navigation.navigate('FolderWorkspace', {
      folderPageId: projectPageId, folderTitle: folder.name, folderId: folder.id,
    })} />;
}

function PhoneFolderListWorkspace({ route, navigation }: NativeStackScreenProps<FolderStackParamList, 'FolderWorkspace'>) {
  return <PhoneFolderWorkspace folderPageId={route.params.folderPageId} folderId={route.params.folderId} navigation={navigation} />;
}

export function PhoneFolderWorkspace({ folderPageId, folderId, navigation }: { folderPageId: string; folderId?: string; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const cardDisplay = useCardDisplay(folderId ?? folderPageId);
  return (
    <FolderWorkspace
      api={api}
      folderPageId={folderPageId}
      folderId={folderId}
      cardDisplay={cardDisplay}
      active={useIsFocused()}
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
      onTitleSaved={(folderTitle) => navigation.setParams({ folderTitle: folderTitle })}
      onOpenFolder={(nextFolderId, nextPageId, nextName) => navigation.push('FolderWorkspace', {
        folderPageId: nextPageId,
        folderTitle: nextName,
        folderId: nextFolderId,
      })}
    />
  );
}

function FolderNavigator() {
  const t = useTokens();
  return (
    <FolderStack.Navigator screenOptions={stackScreenOptions(t)}>
      <FolderStack.Screen
        name="FolderList"
        component={PhoneFolderListScreen}
        options={rootScreenOptions('FolderTab')}
      />
      <FolderStack.Screen
        name="FolderWorkspace"
        component={PhoneFolderListWorkspace}
        options={({ route }) => ({ title: route.params.folderTitle })}
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
    <SessionFeedScreen
      active={useIsFocused()}
      reserveBottomSearchBarSpace
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
    />
  );
}

function PhoneSearchScreen({
  route,
  navigation,
}: NativeStackScreenProps<FeedStackParamList, 'Search'>) {
  const t = useTokens();
  const tabs = navigation.getParent<BottomTabNavigationProp<RootTabParamList>>();
  useLayoutEffect(() => {
    useSearchStore.getState().setQuery(route.params?.initialQuery ?? '');
  }, [route.params?.initialQuery]);
  useFocusEffect(
    useCallback(() => {
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
    }, [navigation, t.colors]),
  );
  return (
    <SearchScreen
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
    />
  );
}

function FeedNavigator() {
  const t = useTokens();
  return (
    <FeedStack.Navigator screenOptions={stackScreenOptions(t)}>
      <FeedStack.Screen name="Feed" component={PhoneSessionFeedScreen} options={rootScreenOptions('FeedTab')} />
      <FeedStack.Screen
        name="Search"
        component={PhoneSearchScreen}
        options={{ title: '검색', headerLargeTitleEnabled: false }}
      />
      <FeedStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드', headerShown: false }} />
      <FeedStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} options={{ headerShown: false }} />
      <FeedStack.Screen name="Chat" component={ChatScreen} options={{ ...rootScreenOptions('ChatTab'), gestureEnabled: false }} />
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
  return (
    <SettingsStack.Navigator screenOptions={stackScreenOptions(t)}>
      <SettingsStack.Screen name="Settings" component={PhoneSettingsScreen} options={{ ...rootScreenOptions('SettingsTab'), headerShown: false }} />
      <SettingsStack.Screen name="RecurringJobs" component={RecurringJobsScreen} options={{ title: '반복 작업' }} />
      <SettingsStack.Screen name="RecurringJobEditor" component={RecurringJobEditorScreen} options={{ title: '반복 작업 편집' }} />
      <SettingsStack.Screen name="RecurringJobHistory" component={RecurringJobHistoryScreen} options={{ title: '실행 이력' }} />
    </SettingsStack.Navigator>
  );
}

export function PhoneSettingsScreen({ navigation }: NativeStackScreenProps<SettingsStackParamList, 'Settings'>) {
  return <SettingsScreen showTitle={false} bottomSafeAreaOwner="parent" />;
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
  const restoredTab = ROOT_TAB_ORDER.find(name => name === initialTab);
  const [focusedTab, setFocusedTab] = useState<keyof RootTabParamList>(restoredTab ?? (host.store.getState().visible ? 'PersistentTab' : INITIAL_ROOT_TAB));
  const t = useTokens();
  const c = t.colors;
  const insets = useSafeAreaInsets();
  const railMode = insets.right >= RAIL_MIN_INSET_WIDTH;
  return (
    <Tab.Navigator
      tabBar={railMode ? (props) => <PhoneRailTabBar {...props} /> : undefined}
      screenLayout={railMode
        ? ({ children }) => (
          <PhoneRailModeContext.Provider value={true}>
            <SafeAreaInsetsContext.Provider value={{ ...insets, right: 0 }}>
              {children}
            </SafeAreaInsetsContext.Provider>
          </PhoneRailModeContext.Provider>
        )
        : undefined}
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
                if (navigation.isFocused() && host.store.getState().session) host.store.getState().toggleScene();
                else void host.requestEntry(() => navigation.navigate('PersistentTab'));
              } } : {}),
            })}
            options={{
              tabBarButtonTestID: `phone-tab-${name}`,
              ...(name === 'PersistentTab' ? { tabBarAccessibilityLabel: focusedTab === 'PersistentTab'
                ? scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기' : '영구 세션 열기' } : {}),
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
