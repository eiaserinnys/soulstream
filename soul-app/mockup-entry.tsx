import '@expo/metro-runtime';
import './component-review/review.css';
import { mockups } from './src/mockups';

async function start() {
  const name = process.env.EXPO_PUBLIC_MOCKUP;
  if (!name || !Object.hasOwn(mockups, name)) {
    throw new Error(`등록되지 않은 앱 시안: ${name}`);
  }
  // Never import index.ts or App.tsx: Observe, push and widget startup belong
  // to the native app. Mockups use the review Metro fixtures without login.
  const [{ registerRootComponent }, { default: Mockup }] = await Promise.all([
    import('expo'), mockups[name as keyof typeof mockups](),
  ]);
  registerRootComponent(Mockup);
}
void start();
