// Run under heavy_verify.py. Playwright is supplied by the caller; it is not an
// app runtime dependency. Only this process's local fixture server is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const [playwrightPath, evidencePath, tabletSize] = process.argv.slice(2);
if (!playwrightPath || !evidencePath) throw new Error('Playwright path와 증거 경로가 필요합니다.');
const { chromium, devices } = require(path.resolve(playwrightPath));
const output = path.resolve(evidencePath);
const root = path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const apiRequests = [];
const result = { passed: false, viewports: [], interactions: [], errors: [], warnings: [], apiRequests };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local.test');
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({ method: req.method, path: url.pathname, authorization: !!req.headers.authorization });
    if (url.pathname !== '/api/auth/status' || req.method !== 'GET') {
      res.writeHead(403); res.end('Unexpected API request'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ authenticated: req.headers.cookie?.includes('review=fixture') === true }));
    return;
  }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});

async function runViewport(browser, base, options, name) {
  const context = await browser.newContext(options);
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.errors.push({ name, message: error.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') result.warnings.push({ name, message: msg.text() });
  });
  await page.addInitScript(() => {
    // Deliberate non-account sentinels prove review storage does not hydrate.
    localStorage.setItem('soul-app-settings', JSON.stringify({ state: { serverUrl: 'https://must-not-read.invalid', appearance: 'dark' }, version: 0 }));
    localStorage.setItem('soul-auth', JSON.stringify({ state: { jwt: 'public-sentinel' }, version: 0 }));
  });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      result.errors.push({ name, message: 'External request: ' + route.request().url() });
      await route.abort(); return;
    }
    await route.continue();
  });
  await page.goto(base + prefix + 'index.html');
  await page.getByTestId('component-review').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const shot = async (part) => {
    await page.screenshot({ path: path.join(output, name + '-' + part + '.png') });
  };
  const tab = (value) => page.getByTestId('settings-segment-review-section-' + value).click();
  const metric = async (id) => page.getByTestId(id).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  result.viewports.push({ name, viewport: options.viewport, screen: options.screen,
    text: await page.getByTestId('review-viewport').textContent(),
    row: await metric('card-row-public-todo-layout') });
  await shot('rows');
  await page.getByTestId('card-row-public-todo-layout').click();
  await page.getByTestId('review-row-selection').waitFor();
  await page.getByTestId('card-row-public-review').getByLabel('완료', { exact: true }).click();
  await page.getByTestId('card-row-public-review').getByText('완료', { exact: true }).waitFor();
  await page.getByTestId('session-card-review-ack').click();
  await page.getByTestId('review-session-rows').scrollIntoViewIfNeeded();
  await shot('sessions');
  result.interactions.push(name + ': 카드 전체 행·로컬 완료·세션 검수 확인');
  await tab('chat');
  const input = page.getByTestId('chat-composer-text-input');
  await input.fill('공개 예시 여러 줄 입력\n두 번째 줄\n세 번째 줄');
  const send = page.getByTestId('chat-composer-send-button');
  await input.click();
  result.viewports[result.viewports.length - 1].composer = {
    input: await metric('chat-composer-text-input'), send: await metric('chat-composer-send-button'),
    content: await metric('chat-composer-content-row'),
  };
  await shot('composer');
  await send.click();
  assert.equal(await input.inputValue(), '');
  await page.getByTestId('chat-composer-attach-button').click();
  await page.getByLabel('공개 예시 첨부 열기').click();
  await page.getByLabel('이미지 닫기').click();
  await page.getByLabel('답변 텍스트 선택', { exact: true }).click();
  await page.getByTestId('message-selection-markdown-source').waitFor();
  await page.getByTestId('message-selection-done').click();
  await page.getByText('공개 예시 답변', { exact: true }).waitFor();
  await page.getByTestId('assistant-message-bubble').first().scrollIntoViewIfNeeded();
  await shot('messages');
  result.interactions.push(name + ': 여러 줄 입력·전송·첨부 확대·Markdown 선택');
  await tab('project');
  await page.getByText('펼치기', { exact: true }).click();
  await page.getByText('접기', { exact: true }).click();
  await page.getByText('편집', { exact: true }).click();
  await page.getByPlaceholder('이 프로젝트의 공통 지침').fill('로컬 저장한 공개 예시');
  await shot('context-edit');
  await page.getByText('컨텍스트 저장', { exact: true }).click();
  await page.getByTestId('folder-context-read-text').waitFor();
  assert.equal(await page.getByTestId('folder-context-read-text').textContent(), '로컬 저장한 공개 예시');
  await shot('context-read');
  result.interactions.push(name + ': 컨텍스트 읽기·펼치기·편집·로컬 저장');
  await tab('settings');
  await page.getByLabel('폴더 선택 열기', { exact: true }).click();
  await page.getByTestId('app-modal-viewport').waitFor();
  await page.getByLabel('전체', { exact: true }).click();
  await page.getByLabel('폴더 검색', { exact: true }).fill('공개 예시 프로젝트');
  await shot('folder-picker');
  await page.getByText('공개 예시 프로젝트', { exact: true }).last().click();
  await page.getByTestId('review-selector-result').waitFor();
  await page.getByLabel('에이전트 선택 열기', { exact: true }).click();
  await page.getByTestId('execution-agent-public-other-agent').waitFor();
  await page.getByTestId('execution-agent-public-other-agent').click();
  await shot('agent-picker');
  await page.getByLabel('실행 대상 확인', { exact: true }).click();
  await page.getByLabel('연결 확인', { exact: true }).click();
  await page.getByText('공개 예시: 연결 확인 성공', { exact: true }).waitFor();
  await page.getByTestId('settings-segment-appearance-dark').click();
  await shot('settings-dark');
  await page.getByTestId('settings-segment-appearance-light').click();
  await page.getByTestId('settings-segment-review-selector-state-error').click();
  await page.getByLabel('폴더 선택 열기', { exact: true }).click();
  await page.getByText('공개 예시: 목록을 불러오지 못했습니다.', { exact: true }).waitFor();
  await shot('folder-error');
  await page.getByText('닫기', { exact: true }).click();
  result.interactions.push(name + ': 폴더 검색·선택·조회 실패·에이전트 선택·설정 로컬 동작·다크');
  await tab('surfaces');
  await page.getByLabel('예시 주요 동작', { exact: true }).click();
  assert.match(await page.getByTestId('review-button-count').textContent(), /1/);
  await shot('surfaces');
  result.interactions.push(name + ': 유리 대체 표면·실제 버튼');
  const storage = await page.evaluate(() => ({ auth: localStorage.getItem('soul-auth'), settings: localStorage.getItem('soul-app-settings') }));
  assert.match(storage.auth, /public-sentinel/);
  assert.match(storage.settings, /must-not-read.invalid/);
  await context.close();
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const denied = await browser.newPage({ viewport: { width: 430, height: 740 } });
    await denied.goto(base + prefix + 'index.html');
    await denied.getByText('로그인 후 앱 컴포넌트 검수로 돌아가기', { exact: true }).waitFor();
    assert.equal(await denied.getByTestId('component-review').count(), 0);
    await denied.close();
    result.interactions.push('미인증 직접 URL: gallery mount 차단');
    const phone = devices['iPhone 14 Pro Max'];
    await runViewport(browser, base, { ...phone, defaultBrowserType: undefined }, 'iphone14-pro-max');
    if (tabletSize) {
      const [width, height] = tabletSize.split('x').map(Number);
      assert.ok(width > height && height >= 700, '확인된 iPad 가로 논리 해상도가 필요합니다.');
      await runViewport(browser, base, { viewport: { width, height }, hasTouch: true }, 'confirmed-ipad-landscape');
    }
    assert.deepEqual(result.errors, []);
    assert.ok(apiRequests.length > 0);
    assert.ok(apiRequests.every((r) => r.method === 'GET' && r.path === '/api/auth/status' && !r.authorization));
    result.passed = true;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.failure = error.message;
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(result, null, 2));
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
