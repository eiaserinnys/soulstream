import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as ScreenOrientation from 'expo-screen-orientation';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { Keyboard, Settings, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContentLinkProvider } from '../src/navigation/ContentLinkProvider';
import { LayoutContinuityProvider } from '../src/navigation/LayoutContinuityContext';
import { PersistentSessionProvider, usePersistentSessionHost } from '../src/navigation/PersistentSessionContext';
import { PersistentSessionScreen } from '../src/screens/PersistentSessionScreen';
import { DUO_RAIL_END_INSET, useDuoSideBand } from '../src/navigation/duoSideBand';
import { DuoTopBandContext } from '../src/navigation/tabContract';
import { PhoneRailTabCluster, type RootTabParamList } from '../src/navigation/TabNavigator';
import { TwoPaneWithDrawer } from '../src/components/split/TwoPaneWithDrawer';
import { useChatStore } from '../src/store/chatStore';
import { useSessionStore } from '../src/store/sessionStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { useUIStore } from '../src/store/uiStore';
import { useTokens } from '../src/theme';
import { session, sessionId, sessionSummary } from './fixture-client';
import { PhaseContext, PhaseMetrics } from './phase-metrics';
const { startScenario } = require('./scenarios.cjs');

const Stack = createNativeStackNavigator();
const innerInsets = { top: 24, right: 84, bottom: 24, left: 0 };
const scenario = String(Settings.get('pasHarnessScenario') || 'pas-portrait');

function prepareFixtures() {
  useSettingsStore.setState({ serverUrl: 'https://native-review.invalid', appearance: 'light' });
  useSessionStore.getState().setSessions([sessionSummary]);
  useChatStore.getState().applyPersistentDisplaySettings(sessionId, {
    show_character: true, animate_character: false, show_generation_separator: true,
    show_jev_candidates: false, turn_usage_mode: 'collapsed',
  });
  useUIStore.setState({
    activeSection: { kind: 'daily', date: '2026-11-03' },
    mainPaneViews: { global: 'board' }, folderOverlayVisible: false,
    cardBoardExpanded: false, selectedCardId: null, settingsVisible: false,
  });
}

function HomeStage({ returnedFromPas = false }: { returnedFromPas?: boolean }) {
  const t = useTokens();
  const [phase, setPhase] = useState(returnedFromPas ? 'home' : 'preparing');
  useEffect(() => {
    prepareFixtures();
    if (returnedFromPas) return;
    const timers = startScenario('home-landscape', {
      band: () => {},
      settings: () => useUIStore.getState().openSettings(),
      closed: () => useUIStore.getState().closeSettings(),
    }, setPhase);
    return () => timers.forEach(clearTimeout);
  }, [returnedFromPas]);
  return <PhaseContext.Provider value={phase}>
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <TwoPaneWithDrawer />
      <PhaseMetrics />
    </View>
  </PhaseContext.Provider>;
}

function PasStage() {
  const host = usePersistentSessionHost();
  const [phase, setPhase] = useState('preparing');
  const [home, setHome] = useState(false);
  const [keyboardProbe, setKeyboardProbe] = useState(false);
  const onHome = () => { Keyboard.dismiss(); setKeyboardProbe(false); host.store.getState().leave(); setHome(true); };
  useEffect(() => {
    prepareFixtures();
    const timers = startScenario(scenario, {
      conversation: () => host.store.getState().open(session),
      reports: () => host.store.getState().toggleReports(),
      cards: () => host.store.getState().toggleCards(),
      keyboard: () => setKeyboardProbe(true),
      home: onHome,
    }, setPhase);
    return () => timers.forEach(clearTimeout);
  }, [host.store]);
  if (home) return <HomeStage returnedFromPas />;
  return <PhaseContext.Provider value={phase}>
    <View style={{ flex: 1 }}>
      {phase !== 'preparing' ? <PersistentSessionScreen active onHome={onHome} /> : null}
      {keyboardProbe ? <TextInput autoFocus style={{ position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, opacity: 0 }} /> : null}
      <PhaseMetrics />
    </View>
  </PhaseContext.Provider>;
}

function OuterRailStage() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const duo = useDuoSideBand();
  const { width, height } = useWindowDimensions();
  const compact = duo && width > height;
  const [active, setActive] = useState<keyof RootTabParamList>('DailyTab');
  const [phase, setPhase] = useState('preparing');
  useEffect(() => {
    prepareFixtures();
    const timers = startScenario(scenario, {
      DailyTab: () => setActive('DailyTab'),
      PersistentTab: () => setActive('PersistentTab'),
    }, setPhase);
    return () => timers.forEach(clearTimeout);
  }, []);
  return <PhaseContext.Provider value={phase}>
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.colors.background }}>
      <View style={{ flex: 1 }} />
      <View style={{ width: insets.right, alignItems: 'center', justifyContent: 'flex-end',
        paddingBottom: compact ? insets.bottom : Math.max(insets.bottom, t.uiSpacing.xxl),
        ...(duo ? { paddingRight: DUO_RAIL_END_INSET } : {}) }}>
        <PhoneRailTabCluster active={active} duoSideBand={duo} compact={compact} onSelect={setActive} />
      </View>
      <PhaseMetrics />
    </View>
  </PhaseContext.Provider>;
}

function HarnessStage() {
  if (scenario === 'home-landscape') return <HomeStage />;
  if (scenario.startsWith('outer-rail')) return <OuterRailStage />;
  return <PasStage />;
}

function Root() {
  const t = useTokens();
  const skipRotation = Settings.get('pasHarnessSkipRotation') === true || Settings.get('pasHarnessSkipRotation') === 'true';
  const [ready, setReady] = useState(!scenario.endsWith('landscape') || skipRotation);
  useEffect(() => {
    if (!scenario.endsWith('landscape') || skipRotation) return;
    let cancelled = false;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT)
      .catch(error => console.warn('landscape lock failed', error))
      .finally(() => { if (!cancelled) setTimeout(() => setReady(true), 1500); });
    return () => { cancelled = true; };
  }, []);
  const stage = <LayoutContinuityProvider><PersistentSessionProvider><ContentLinkProvider>
    <NavigationContainer theme={DefaultTheme}>
      <DuoTopBandContext.Provider value={scenario === 'pas-portrait' ? true : null}>
        <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: t.colors.background } }}>
          <Stack.Screen name="Harness" component={HarnessStage} />
        </Stack.Navigator>
      </DuoTopBandContext.Provider>
    </NavigationContainer>
  </ContentLinkProvider></PersistentSessionProvider></LayoutContinuityProvider>;
  const forceInner = scenario === 'home-landscape' || scenario === 'pas-landscape';
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    {ready ? (forceInner ? <SafeAreaInsetsContext.Provider value={innerInsets}>{stage}</SafeAreaInsetsContext.Provider> : stage)
      : <Text>Preparing orientation</Text>}
  </SafeAreaProvider></GestureHandlerRootView>;
}

registerRootComponent(Root);
