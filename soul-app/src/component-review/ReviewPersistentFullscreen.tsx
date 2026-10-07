import React, { useEffect } from 'react';
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../navigation/PersistentSessionContext';
import { PersistentSessionStartup } from '../navigation/PersistentSessionStartup';
import { TabletNavigator } from '../navigation/TabletNavigator';
import { TabNavigator } from '../navigation/TabNavigator';
import { useDeviceType, useTokens } from '../theme';

const navigation = createNavigationContainerRef<any>();
function EntryDriver({ ready, phone }: { ready: boolean; phone: boolean }) {
  const host = usePersistentSessionHost();
  useEffect(() => {
    if (!ready || new URLSearchParams(window.location.search).get('sample') !== 'screen') return;
    void host.requestEntry(() => { navigation.navigate(phone ? 'PersistentTab' : 'PersistentSession'); }, true);
  }, [ready, phone]);
  return null;
}

function CardOverlayEntryDriver({ ready, phone }: { ready: boolean; phone: boolean }) {
  const host = usePersistentSessionHost();
  useEffect(() => {
    if (!ready || new URLSearchParams(window.location.search).get('sample') !== 'card-overlay') return;
    host.store.getState().open({ session_id: 'review-pas-1', display_name: '영구 관제 세션', node_id: 'public-node',
      folder_id: null, agent_id: 'public-agent', agent_name: '로젤린', persistent: true, settings: {},
      runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null } } as any);
    host.store.getState().toggleScene();
    navigation.navigate(phone ? 'PersistentTab' : 'PersistentSession');
  }, [ready, phone, host.store]);
  return null;
}

/** 실제 틀과 실제 iPad 스택. fixture는 Metro의 API 경계에서만 주입한다. */
export function ReviewPersistentFullscreen() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const [ready, setReady] = React.useState(false);
  const sample = new URLSearchParams(window.location.search).get('sample');
  return <PersistentSessionProvider>
    <NavigationContainer ref={navigation} theme={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: t.colors.background } }}
      onReady={() => setReady(true)}>
      {phone ? <TabNavigator /> : <TabletNavigator />}
    </NavigationContainer>
    {sample === 'card-overlay' ? <CardOverlayEntryDriver ready={ready} phone={phone} />
      : sample !== 'screen'
        ? <PersistentSessionStartup ready={ready} sessionIntent={false} onOpen={() => { navigation.navigate(phone ? 'PersistentTab' : 'PersistentSession'); }} />
        : <EntryDriver ready={ready} phone={phone} />}
  </PersistentSessionProvider>;
}
