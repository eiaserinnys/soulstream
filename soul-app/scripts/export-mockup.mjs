import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const name = process.env.MOCKUP;
if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('MOCKUP에 시안 이름이 필요합니다.');

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const mockupRoot = path.join(appRoot, 'mockup');
const output = path.join(appRoot, 'dist-mockups', name);
const cli = path.join(appRoot, 'node_modules/expo/bin/cli');

execFileSync(process.execPath, [cli, 'export', '--platform', 'web',
  '--output-dir', output, '--max-workers', '2'], {
  cwd: mockupRoot, stdio: 'inherit',
  env: { ...process.env, EXPO_PUBLIC_MOCKUP: name },
});
if (!existsSync(path.join(output, 'index.html'))) throw new Error('시안 번들 index.html이 없습니다.');
console.log('앱 시안 export:', output);
