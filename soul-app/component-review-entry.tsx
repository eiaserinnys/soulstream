import '@expo/metro-runtime';
import './component-review/review.css';
import { checkReviewAuth } from './src/component-review/auth';

async function start() {
  if (!await checkReviewAuth()) {
    const root = document.getElementById('root');
    if (root) {
      const link = document.createElement('a');
      link.href = '/components/ios';
      link.textContent = '로그인 후 앱 컴포넌트 검수로 돌아가기';
      root.replaceChildren(link);
    }
    return;
  }
  // Import the gallery only after cookie authentication. Never import index.ts
  // or App.tsx: their Observe, push and widget startup belongs to the native app.
  const [{ registerRootComponent }, { ComponentReview, initializeReview }] = await Promise.all([
    import('expo'), import('./src/component-review/ComponentReview'),
  ]);
  initializeReview();
  registerRootComponent(ComponentReview);
}
void start();
