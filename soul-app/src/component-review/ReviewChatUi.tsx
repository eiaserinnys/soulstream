import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../navigation/PersistentSessionContext';
import { TabNavigator } from '../navigation/TabNavigator';
import { TabletNavigator } from '../navigation/TabletNavigator';
import { ChatPane } from '../components/split/ChatPane';
import { useDeviceType, useTokens } from '../theme';
import { chatUiReviewSessionId } from './chat-ui-flow-fixtures';

const navigation = createNavigationContainerRef<any>();
function EntryDriver({ ready, phone, manuscript }: { ready: boolean; phone: boolean; manuscript: boolean }) {
  const host = usePersistentSessionHost();
  useEffect(() => {
    if (!ready) return;
    if (manuscript) {
      host.store.getState().open({ session_id: chatUiReviewSessionId, display_name: '채팅 UI', node_id: 'public-node',
        folder_id: null, agent_id: 'public-agent', agent_name: 'Assistant', persistent: true,
        settings: { default_model: { model_preset: null, reasoning_effort: null }, turn_usage_mode: 'collapsed' },
        runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null } });
      navigation.navigate(phone ? 'PersistentTab' : 'PersistentSession');
    } else if (phone) navigation.navigate('FeedTab', { screen: 'Chat', params: { sessionId: chatUiReviewSessionId } });
  }, [ready, phone, manuscript, host.store]);
  return null;
}

/** Real phone ChatScreen / tablet ChatPane / PAS frames, with REST and SSE fixtures. */
export function ReviewChatUi() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const manuscript = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('presentation') === 'manuscript';
  const [ready, setReady] = useState(false);
  if (!phone && !manuscript) return <SafeAreaView style={{ flex: 1 }}>
    <ChatPane sessionId={chatUiReviewSessionId} onClose={() => {}} />
  </SafeAreaView>;
  return <View style={{ flex: 1 }}><PersistentSessionProvider>
    <NavigationContainer ref={navigation} theme={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: t.colors.background } }}
      onReady={() => setReady(true)}>
      {phone ? <TabNavigator /> : <TabletNavigator />}
    </NavigationContainer>
    <EntryDriver ready={ready} phone={phone} manuscript={manuscript} />
  </PersistentSessionProvider></View>;
}
