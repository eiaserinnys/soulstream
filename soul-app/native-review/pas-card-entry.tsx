import 'react-native-gesture-handler';
import React, { useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { Text, TextInput, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContentLinkProvider } from '../src/navigation/ContentLinkProvider';
import { LayoutContinuityProvider, useLayoutContinuity } from '../src/navigation/LayoutContinuityContext';
import { PersistentSessionProvider, usePersistentSessionHost } from '../src/navigation/PersistentSessionContext';
import { PersistentSessionScreen } from '../src/screens/PersistentSessionScreen';
import { useChatStore } from '../src/store/chatStore';
import { useSessionStore } from '../src/store/sessionStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { useTokens } from '../src/theme';
import { cardKey, session, sessionId, sessionSummary } from './fixture-client';

function Stage() {
  const host = usePersistentSessionHost();
  const continuity = useLayoutContinuity();
  const insets = useSafeAreaInsets();
  const t = useTokens();
  const [phase, setPhase] = useState<'preparing' | 'closed 1' | 'open' | 'closed 2' | 'keyboard'>('preparing');
  const keyboardInput = useRef<TextInput>(null);
  useEffect(() => {
    useSettingsStore.setState({ serverUrl: 'https://native-review.invalid', appearance: 'light' });
    useSessionStore.getState().setSessions([sessionSummary]);
    useChatStore.getState().applyPersistentDisplaySettings(sessionId, {
      show_character: true, animate_character: false, show_generation_separator: true,
      show_jev_candidates: false, turn_usage_mode: 'collapsed',
    });
    host.store.getState().open(session);
    const key = JSON.stringify(['pas', sessionId]);
    continuity.setViewState(key, { expandedKey: null });
    setPhase('closed 1');
    const open = setTimeout(() => { continuity.setViewState(key, { expandedKey: cardKey }); setPhase('open'); }, 6000);
    const close = setTimeout(() => { continuity.setViewState(key, { expandedKey: null }); setPhase('closed 2'); }, 21000);
    const keyboard = setTimeout(() => { continuity.setViewState(key, { expandedKey: null }); setPhase('keyboard'); }, 27000);
    return () => { clearTimeout(open); clearTimeout(close); clearTimeout(keyboard); };
  }, [continuity, host.store]);
  useEffect(() => {
    if (phase === 'keyboard') keyboardInput.current?.focus();
  }, [phase]);
  return <View style={{ flex: 1 }}>
    {phase !== 'preparing' ? <PersistentSessionScreen key={phase} active onHome={() => {}} /> : null}
    <TextInput ref={keyboardInput} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: -100, top: 0, width: 1, height: 1, opacity: 0 }} />
    <View pointerEvents="none" style={{ position: 'absolute', top: insets.top, left: t.spacing.sm, zIndex: 100 }}>
      <Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary, backgroundColor: t.colors.background }}>{phase}</Text>
    </View>
  </View>;
}

function Root() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    <LayoutContinuityProvider><PersistentSessionProvider><ContentLinkProvider>
      <NavigationContainer theme={DefaultTheme}><Stage /></NavigationContainer>
    </ContentLinkProvider></PersistentSessionProvider></LayoutContinuityProvider>
  </SafeAreaProvider></GestureHandlerRootView>;
}

registerRootComponent(Root);
