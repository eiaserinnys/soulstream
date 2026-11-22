import { useEffect, useState, type ComponentProps } from 'react';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { FilesTitle, RefreshButton, SessionFilesContent } from '../screens/SessionFilesScreen';
import { useTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';
export { reviewWorkspace } from './session-files-fixtures';

const Stack = createNativeStackNavigator<{ Start: undefined; Files: undefined }>();
function Start({ navigation }: { navigation: { navigate(name: 'Files'): void } }) {
  useEffect(() => { navigation.navigate('Files'); }, [navigation]);
  return null;
}

export function ReviewSessionFiles() {
  const t = useTokens();
  const [header, setHeader] = useState<ComponentProps<typeof FilesTitle>['header']>(null);
  const roles = createSurfaceRoles(t);
  const base = t.mode === 'dark' ? DarkTheme : DefaultTheme;
  return <NavigationContainer theme={{ ...base, colors: { ...base.colors, background: t.colors.background } }}>
    <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: roles.chrome.tokenStyle.backgroundColor as string }, headerTintColor: t.colors.textPrimary, headerShadowVisible: false, contentStyle: roles.canvas.tokenStyle }}>
      <Stack.Screen name="Start" component={Start} options={{ headerShown: false }} />
      <Stack.Screen name="Files" options={{ headerTitle: () => <FilesTitle header={header} />, headerRight: () => <RefreshButton header={header} /> }}>
        {() => <SessionFilesContent sessionId="review-files" active onHeader={setHeader} />}
      </Stack.Screen>
    </Stack.Navigator>
  </NavigationContainer>;
}
