// Host + real exported RN iframe. Local Vite and fixture HTTP interception only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [playwrightPath, evidencePath] = process.argv.slice(2);
if (!playwrightPath || !evidencePath) throw new Error('Playwright와 증거 경로가 필요합니다.');
const { chromium } = require(path.resolve(playwrightPath));
const dashboard = path.resolve(__dirname, '../../unified-dashboard');
const root = path.join(dashboard, 'dist/assets/ios-components');
const output = path.resolve(evidencePath);
let base;
const prefix = '/assets/ios-components/';
const evidence = { passed: false, viewports: [], mutations: [], requests: [], errors: [] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
async function run(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('soul-dashboard-theme', 'light');
    localStorage.setItem('ls.webglGlass', '0');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const entry = { width, host: new URL(page.url()).pathname, method: request.method(), path: url.pathname };
    evidence.requests.push(entry);
    if (entry.host.startsWith('/dialogues/ios') && !['GET', 'HEAD'].includes(request.method())) evidence.mutations.push(entry);
    const body = url.pathname === '/api/auth/status'
      ? { authenticated: true, user: { email: 'qa@example.test', name: 'QA', isAdmin: false } }
      : url.pathname === '/api/auth/config' ? { authEnabled: true, devModeEnabled: false }
      : url.pathname === '/api/user/preferences' ? { preferences: { appearance: 'light', glass: { enabled: false } }, email: 'qa@example.test', hasBackground: false }
      : { folders: [], sessions: [], nodes: [], cards: [], items: [], enabled: false };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/assets/ios-components/**', async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
    assert.ok(file.startsWith(root + path.sep));
    await route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) });
  });
  const shot = name => page.screenshot({ path: path.join(output, 'host-' + width + '-' + name + '.png'), animations: 'disabled' });
  await page.goto(base + '/components/ios');
  await page.frameLocator('iframe').getByTestId('component-review').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.frameLocator('iframe').locator('body').evaluate(() => document.fonts.ready);
  const before = await shot('components-before');
  await page.goto(base + (width === 390 ? '/dialogues/ios/' : '/dialogues/ios'));
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('선택한 다이얼로그 열기', { exact: true }).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('src'), prefix + 'index.html?section=dialogues');
  await page.reload();
  await frame.getByLabel('선택한 다이얼로그 열기', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.getByTestId('ios-components-review').evaluate(el => {
    const box = node => {
      const b = node.getBoundingClientRect();
      return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    return { header: box(el.querySelector('header')), frame: box(el.querySelector('iframe')),
      title: box(el.querySelector('h1')), cap: box(el.querySelector('button')),
      documentWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  assert.equal(metrics.documentWidth, width);
  assert.ok(Math.abs(metrics.header.x - metrics.frame.x) <= 1);
  assert.ok(Math.abs(metrics.header.right - metrics.frame.right) <= 1);
  assert.ok(Math.abs(metrics.title.y + metrics.title.height / 2 - metrics.cap.y - metrics.cap.height / 2) <= 1);
  assert.equal(await frame.locator('html').evaluate(el => el.scrollWidth > innerWidth), false);
  await shot('dialogues');
  await frame.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
  await frame.getByTestId('app-modal-viewport').waitFor();
  await shot('card-create');
  await frame.getByLabel('카드 작성 취소', { exact: true }).click();
  await page.goto(base + '/components/ios');
  await page.frameLocator('iframe').getByTestId('component-review').waitFor();
  await page.frameLocator('iframe').locator('body').evaluate(() => document.fonts.ready);
  const after = await shot('components-after');
  assert.ok(before.equals(after), '기존 /components/ios 화면이 달라졌습니다.');
  evidence.viewports.push({ width, metrics, directEntry: true, refresh: true, iframeLoaded: true, componentsUnchanged: true });
  await page.close();
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const portServer = require('node:net').createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  base = 'http://127.0.0.1:' + port;
  const vite = spawn(process.execPath, [require('node:fs').realpathSync(path.join(dashboard, 'node_modules/vite/bin/vite.js')), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: dashboard, env: { ...process.env, VITE_API_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Vite startup timeout')), 60000);
      vite.stdout.on('data', chunk => { if (chunk.toString().includes(base)) { clearTimeout(timeout); resolve(); } });
      vite.stderr.on('data', chunk => process.stderr.write(chunk));
      vite.on('exit', code => { clearTimeout(timeout); reject(new Error('Vite exited: ' + code)); });
    });
    browser = await chromium.launch({ headless: true });
    await run(browser, 1440); await run(browser, 390);
    assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.mutations, []);
    evidence.passed = true; console.log(JSON.stringify(evidence, null, 2));
  } catch (error) { evidence.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.join(output, 'host-evidence.json'), JSON.stringify(evidence, null, 2));
    await browser?.close(); vite.kill('SIGTERM');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
