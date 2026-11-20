import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const reviewRoot = path.join(appRoot, 'component-review');
const output = path.resolve(appRoot, '../unified-dashboard/dist/assets/ios-components');
const cli = path.join(appRoot, 'node_modules/expo/bin/cli');

// A separate Expo project selects the review entry and base URL, without
// rewriting the native app's package.json, app.json or Metro configuration.
execFileSync(process.execPath, [cli, 'export', '--platform', 'web',
  '--output-dir', output, '--max-workers', '2'], {
  cwd: reviewRoot, stdio: 'inherit',
  // 격리 세션에서는 홈이 읽기 전용이라 Expo 텔레메트리가 state.json을 쓰다 실패한다.
  env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
});
if (!existsSync(path.join(output, 'index.html'))) throw new Error('검수 번들 index.html이 없습니다.');
console.log('앱 컴포넌트 export:', output);
