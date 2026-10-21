import React, { useCallback } from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer, useNavigationContainerRef, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { PersistentSessionProvider } from '../navigation/PersistentSessionContext';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { PhoneMarkdownDocument, type MarkdownDocumentRouteParams } from '../navigation/PhoneContentScreens';
import { TabletNavigator, type TabletStackParamList } from '../navigation/TabletNavigator';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useDeviceType, useTokens } from '../theme';
import { contentLinkDocumentId } from './fixture-client';

const states = [
  { value: 'ready', label: '읽힘' },
  { value: 'loading', label: '불러오는 중' },
  { value: 'error', label: '실패' },
] as const;
type DocumentState = typeof states[number]['value'];
type PhoneReviewStack = { Home: undefined; MarkdownDocument: MarkdownDocumentRouteParams };
const PhoneStack = createNativeStackNavigator<PhoneReviewStack>();

function EmptyHome() {
  return <View style={{ flex: 1 }} />;
}

function PhoneDocumentSample({ theme }: { theme: Theme }) {
  const navigation = useNavigationContainerRef<PhoneReviewStack>();
  const openDocument = useCallback(() => {
    navigation.navigate('MarkdownDocument', { documentId: contentLinkDocumentId });
  }, [navigation]);
  return <NavigationContainer ref={navigation} theme={theme} onReady={openDocument}>
    <PhoneStack.Navigator initialRouteName="Home" screenOptions={{ headerShown: false }}>
      <PhoneStack.Screen name="Home" component={EmptyHome} />
      <PhoneStack.Screen name="MarkdownDocument" component={PhoneMarkdownDocument} />
    </PhoneStack.Navigator>
  </NavigationContainer>;
}

function TabletDocumentSample() {
  const navigation = useNavigationContainerRef<TabletStackParamList>();
  const openDocument = useCallback(() => {
    navigation.navigate('MarkdownDocument', { documentId: contentLinkDocumentId });
  }, [navigation]);
  return <NavigationContainer ref={navigation} onReady={openDocument}>
    <PersistentSessionProvider>
      <ContentLinkProvider><TabletNavigator /></ContentLinkProvider>
    </PersistentSessionProvider>
  </NavigationContainer>;
}

export function ReviewContentLinkDocument() {
  const t = useTokens();
  const device = useDeviceType();
  const dark = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('theme') === 'dark';
  const navigationTheme = dark ? DarkTheme : DefaultTheme;
  const value = typeof window === 'undefined' ? 'ready' : new URLSearchParams(window.location.search).get('documentState');
  const state: DocumentState = value === 'loading' || value === 'error' ? value : 'ready';
  return <View style={{ flex: 1, backgroundColor: t.colors.background }}>
    <SettingsSegmentedControl<DocumentState> id="content-link-document-state" value={state}
      onChange={(next) => {
        const url = new URL(window.location.href);
        url.searchParams.set('section', 'contentLinkDocument');
        url.searchParams.set('documentState', next);
        url.searchParams.set('safeArea', 'fixture');
        window.location.assign(url.toString());
      }} options={states} />
    <View style={{ flex: 1 }}>
      {device === 'phone' ? <PhoneDocumentSample theme={navigationTheme} /> : <TabletDocumentSample />}
    </View>
  </View>;
}
