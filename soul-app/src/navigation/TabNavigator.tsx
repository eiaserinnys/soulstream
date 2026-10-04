import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import {
  createBottomTabNavigator,
  type BottomTabNavigationProp,
  type BottomTabScreenProps,
} from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import {
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
import { useTokens, type DesignTokens } from '../theme';
import { INITIAL_ROOT_TAB, ROOT_TAB_ORDER } from './tabContract';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { useCardStore } from '../store/cardStore';
import { FolderWorkspace } from '../components/planner/FolderWorkspace';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import { openPhoneChat, openPhoneSearchSession } from './phoneSessionNavigation';
import { useSearchStore } from '../store/searchStore';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
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

export function getDefaultTabBarStyle(colors: DesignTokens['colors']): ViewStyle {
  return {
    backgroundColor: 'transparent',
    borderTopColor: colors.border,
    overflow: 'hidden',
  };
}

function TabBarGlassBackground() {
  return (
    <GlassSurface
      role="chrome"
      style={StyleSheet.absoluteFill}
    />
  );
}

export type RootTabParamList = {
  DailyTab: undefined;
  FolderTab: NavigatorScreenParams<FolderStackParamList> | undefined;
  FeedTab: NavigatorScreenParams<FeedStackParamList> | undefined;
  ChatTab: {
    screen: 'Chat';
    params: {
      sessionId: string;
      focusEventId?: number;
      storyOpenRequestId?: number;
      usageEntry?: 'notification';
    };
  } | undefined;
  SettingsTab: undefined;
};

export type DailyStackParamList = {
  Daily: undefined;
  DailyHistory: undefined;
  FolderWorkspace: { folderPageId: string; folderTitle: string; folderId?: string };
  CardDetail: { cardId: string };
};
export type FolderStackParamList = {
  FolderList: undefined;
  FolderWorkspace: { folderPageId: string; folderTitle: string; folderId?: string };
  CardDetail: { cardId: string };
};
export type FeedStackParamList = {
  Feed: undefined;
  Search: { initialQuery?: string } | undefined;
};
export type ChatStackParamList = {
  Chat: {
    sessionId?: string;
    focusEventId?: number;
    storyOpenRequestId?: number;
    usageEntry?: 'notification';
  } | undefined;
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
const ChatStack = createNativeStackNavigator<ChatStackParamList>();
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
      <DailyStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드' }} />
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

export function PhoneCardDetail({ route, navigation }: { route: { params: { cardId: string } }; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const title = useCardStore((state) => state.rows[route.params.cardId]?.title ?? '카드');
  useLayoutEffect(() => { navigation.setOptions({ title }); }, [navigation, title]);
  return <CardDetailContent nativeHeader api={api} cardId={route.params.cardId} onClose={() => navigation.goBack()}
    onOpenSession={(id) => openPhoneChat(navigation, id)} />;
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
      <FolderStack.Screen name="CardDetail" component={PhoneCardDetail} options={{ title: '카드' }} />
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
    </FeedStack.Navigator>
  );
}

function ChatNavigator() {
  const t = useTokens();
  return (
    <ChatStack.Navigator screenOptions={stackScreenOptions(t)}>
      <ChatStack.Screen name="Chat" component={ChatScreen} options={rootScreenOptions('ChatTab')} />
    </ChatStack.Navigator>
  );
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
  ChatTab: ChatNavigator,
  SettingsTab: SettingsNavigator,
};

export function TabNavigator() {
  return (
    <PhonePanelHistoryProvider>
      <PhoneTabNavigator />
    </PhonePanelHistoryProvider>
  );
}

function PhoneTabNavigator() {
  useSessionsStream();
  useNodeConnectivityStream();
  const panelHistory = usePhonePanelHistory();
  const t = useTokens();
  const c = t.colors;
  return (
    <Tab.Navigator
      initialRouteName={INITIAL_ROOT_TAB}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
        tabBarShowLabel: false,
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
            listeners={{ focus: () => panelHistory.recordFocus(name) }}
            options={{
              tabBarIcon: ({ color, size }) => (
                <Ionicons name={config.icon} color={color} size={size} />
              ),
            }}
          />
        );
      })}
    </Tab.Navigator>
  );
}
