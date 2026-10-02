import '@expo/metro-runtime';
import './component-review/review.css';
import { checkReviewAuth } from './src/component-review/auth';

async function start() {
  if (!await checkReviewAuth()) return;
  const [React, { registerRootComponent }, { GestureHandlerRootView }, { SafeAreaProvider },
    { ReviewCardImages }, { useSettingsStore }, { useAuthStore }] = await Promise.all([
      import('react'), import('expo'), import('react-native-gesture-handler'), import('react-native-safe-area-context'),
      import('./src/component-review/ReviewCardImages'), import('./src/store/settingsStore'), import('./src/store/authStore'),
    ]);
  const serverUrl = window.location.origin;
  useSettingsStore.setState({ serverUrl, appearance: 'dark' });
  // LOCAL HTTP CAPTURE ONLY, not selected by native index.ts or export:components.
  // Metro aliases SecureStore to fixture-secure-store's in-memory Map, so this
  // invented value cannot replace an OS Keychain JWT or browser login cookie.
  // The normal ComponentReview menu imports ReviewCardImages, never this entry.
  useAuthStore.setState({ jwt: 'public-image-review-token' });
  registerRootComponent(() => <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    <ReviewCardImages serverUrl={serverUrl} />
  </SafeAreaProvider></GestureHandlerRootView>);
}
void start();
