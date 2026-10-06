import React, { useEffect } from 'react';
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../navigation/PersistentSessionContext';
import { PersistentSessionStartup } from '../navigation/PersistentSessionStartup';
import { TabletNavigator } from '../navigation/TabletNavigator';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { useDeviceType, useTokens } from '../theme';

const navigation = createNavigationContainerRef<any>();
function EntryDriver({ ready, phone }: { ready: boolean; phone: boolean }) {
  const host = usePersistentSessionHost();
  useEffect(() => {
    if (!ready || new URLSearchParams(window.location.search).get('sample') !== 'screen') return;
    void host.requestEntry(() => { if (!phone) navigation.navigate('PersistentSession'); }, true);
  }, [ready, phone]);
  return null;
}

/** 실제 틀과 실제 iPad 스택. fixture는 Metro의 API 경계에서만 주입한다. */
export function ReviewPersistentFullscreen() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const [ready, setReady] = React.useState(false);
  return <PersistentSessionProvider>
    <NavigationContainer ref={navigation} theme={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: t.colors.background } }}
      onReady={() => setReady(true)}>
      {phone ? <PersistentSessionScreen onHome={() => {}} onOpenCard={() => {}} /> : <TabletNavigator />}
    </NavigationContainer>
    {new URLSearchParams(window.location.search).get('sample') === 'startup'
      ? <PersistentSessionStartup ready={ready} sessionIntent={false} onOpen={() => { if (!phone) navigation.navigate('PersistentSession'); }} />
      : <EntryDriver ready={ready || phone} phone={phone} />}
  </PersistentSessionProvider>;
}
