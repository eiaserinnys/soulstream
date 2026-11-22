import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { SessionWorkspaceResponse } from '../../../packages/wire-schema/src/session_workspace';
import { FilesTitle, RefreshButton, SessionFilesView } from '../screens/SessionFilesScreen';
import { FrameLoading } from '../components/FrameLoading';
import { useTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';

const baseFile = { orig_path: null, added: null, deleted: null, size: 1100, wrote: false, read: false, committed: false, last_activity_at: null };
export const reviewWorkspace: SessionWorkspaceResponse = {
  session_id: 'review-files', root: '/workspace/soulstream', node: { id: 'example', status: 'ok' }, attribution: 'full',
  snapshot: { state: 'ready', observed_at: '2026-11-22T06:12:00Z', refreshing: false, branch: 'card1802-outbox-backoff', head: null, upstream: null, ahead: 1, behind: 0, truncated: false },
  files: [
    { ...baseFile, path: 'soul-server-ts/src/config.ts', git_status: 'modified', added: 3, deleted: 1 },
    { ...baseFile, path: 'soul-server-ts/src/upstream/event_outbox_types.ts', git_status: null, wrote: true, committed: true },
    { ...baseFile, path: 'soul-server-ts/src/upstream/event_outbox.ts', git_status: 'modified', wrote: true, added: 42, deleted: 18 },
    { ...baseFile, path: 'soul-server-ts/src/upstream/outbox_retry.ts', git_status: 'untracked', wrote: true, added: 33, deleted: 0 },
    { ...baseFile, path: 'soul-server-ts/tests/upstream/event_outbox.test.ts', git_status: 'modified', wrote: true, added: 61, deleted: 4 },
  ],
  read_only: [{ path: 'soul-server-ts/src/upstream/dispatcher.ts', size: null, last_read_at: null }, { path: 'packages/db-schema/sql/schema.sql', size: 1100, last_read_at: null }],
};
const Stack = createNativeStackNavigator<{ Start: undefined; Files: undefined }>();
function Start({ navigation }: { navigation: { navigate(name: 'Files'): void } }) {
  useEffect(() => { navigation.navigate('Files'); }, [navigation]);
  return null;
}

export function ReviewSessionFiles() {
  const t = useTokens();
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const sample = params?.get('sample') ?? 'list';
  const [selected, setSelected] = useState<string | null>(sample === 'preview' ? 'soul-server-ts/src/upstream/outbox_retry.ts' : null);
  const [expanded, setExpanded] = useState(false);
  const [retry, setRetry] = useState(false);
  const long = sample === 'long';
  const data: SessionWorkspaceResponse = {
    ...reviewWorkspace,
    node: { ...reviewWorkspace.node, status: sample === 'offline' ? 'offline' : 'ok' },
    files: long ? reviewWorkspace.files.map(file => ({ ...file, path: `${file.path}-아주-긴-파일-이름이-있는-경우-레이아웃을-살펴봅니다-1234567890.ts` })) : reviewWorkspace.files,
  };
  const header = { title: long ? '아주-긴-브랜치-이름-레이아웃을-살펴봅니다-1234567890' : data.snapshot!.branch!, branch: true, ahead: 1, behind: 0, refreshing: false, refresh: () => setRetry(true) };
  const roles = createSurfaceRoles(t);
  const base = t.mode === 'dark' ? DarkTheme : DefaultTheme;
  return <NavigationContainer theme={{ ...base, colors: { ...base.colors, background: t.colors.background } }}>
    <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: roles.chrome.tokenStyle.backgroundColor as string }, headerTintColor: t.colors.textPrimary, headerShadowVisible: false, contentStyle: roles.canvas.tokenStyle }}>
      <Stack.Screen name="Start" component={Start} options={{ headerShown: false }} />
      <Stack.Screen name="Files" options={{ headerTitle: () => <FilesTitle header={header} />, headerRight: () => <RefreshButton header={header} /> }}>
        {() => <View style={{ flex: 1 }}>
          {sample === 'loading' ? <FrameLoading text="파일 상태를 읽는 중" /> : <SessionFilesView data={sample === 'error' && !retry ? null : data} error={sample === 'error' && !retry} refreshing={false} onRefresh={() => setRetry(true)}
            expanded={expanded} onToggle={() => setExpanded(value => !value)} selected={selected} onSelect={setSelected} sessionId="review-files" />}
        </View>}
      </Stack.Screen>
    </Stack.Navigator>
  </NavigationContainer>;
}
