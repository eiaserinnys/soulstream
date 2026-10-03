// Actual RN export only. Run under heavy_verify.py, never against production.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const [playwrightPath, evidencePath, remaining] = process.argv.slice(2);
if (!playwrightPath || !evidencePath) throw new Error('Playwright와 증거 경로가 필요합니다.');
const { chromium } = require(path.resolve(playwrightPath));
const output = path.resolve(evidencePath);
const root = path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const evidence = { passed: false, samples: [], errors: [], requests: [], warnings: [], viewports: [] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local');
  if (url.pathname.startsWith('/api/')) {
    evidence.requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: true })); return;
    }
    res.writeHead(403); res.end('Unexpected API request'); return;
  }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(await fs.readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
const samples = ['card-create', 'assignment', 'folder-picker', 'execution-picker', 'folder-create', 'session-create',
  'session-diagnostic', 'morning-review', 'search-filter', 'settings', 'task-output', 'board-expanded', 'card-status', 'image-viewer'];
async function metrics(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="task-workspace-sheet"]');
    const rect = sheet?.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyOverflow: getComputedStyle(document.body).overflow,
      overlay: rect ? { x: rect.x, width: rect.width, right: rect.right, transform: getComputedStyle(sheet).transform } : null };
  });
}
async function measureBefore(browser, base) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base + prefix + 'index.html?section=dialogues');
  await page.getByTestId('component-review').waitFor();
  const before = await metrics(page);
  await page.getByLabel('카드 상세 오버레이 열기', { exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('[data-testid="task-workspace-sheet"]').getBoundingClientRect().x - 39) < 1);
  const opened = await metrics(page);
  await page.getByLabel('뒤로', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="task-workspace-sheet"]').getBoundingClientRect().x >= 389);
  const closed = await metrics(page);
  await fs.writeFile(path.join(output, 'overflow-before.json'), JSON.stringify({ before, opened, closed }, null, 2));
  console.log(JSON.stringify({ before, opened, closed }, null, 2)); await page.close();
}
async function capture(browser, base, name, viewport, verifySamples = true, verifySaves = true) {
  const context = await browser.newContext({ viewport, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => evidence.errors.push({ name, message: error.message }));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) evidence.warnings.push({ name, message: message.text() }); });
  await page.addInitScript(() => {
    localStorage.setItem('soul-app-settings', 'public-sentinel-settings');
    localStorage.setItem('soul-auth', 'public-sentinel-auth');
  });
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== base) {
      evidence.errors.push({ name, message: 'external request: ' + route.request().url() }); await route.abort();
    } else await route.continue();
  });
  await page.goto(base + prefix + 'index.html?section=dialogues');
  await page.getByTestId('component-review').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const shot = part => page.screenshot({ path: path.join(output, name + '-' + part + '.png') });
  await shot('gallery');
  for (const sample of verifySamples ? samples : []) {
    await page.getByTestId('settings-segment-review-dialogue-' + sample).click();
    await page.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
    if (sample === 'task-output') {
      await page.getByTestId('runtime-tasks-header-touch').click();
      await page.getByTestId('runtime-task-output-touch-public-task').click();
    }
    const modal = sample === 'image-viewer' ? page.getByTestId('image-viewer-pages') : page.getByTestId('app-modal-viewport');
    await modal.waitFor();
    await page.getByRole('dialog').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await shot(sample);
    if (sample === 'search-filter') {
      await page.getByText('7일', { exact: true }).click();
      await page.getByLabel('검색 필터 닫기', { exact: true }).click();
      assert.match(await page.getByTestId('review-dialogue-result').textContent(), /검색 필터 변경/);
    } else {
      await page.keyboard.press('Escape');
    }
    await modal.waitFor({ state: 'hidden' });
    evidence.samples.push({ name, sample, opened: true, closed: true });
  }
  const open = async sample => {
    await page.getByTestId('settings-segment-review-dialogue-' + sample).click();
    await page.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
  };
  if (verifySaves) {
  await open('card-create');
  await page.getByLabel('카드 제목', { exact: true }).fill('메모리 카드');
  await page.getByLabel('요청 원문', { exact: true }).fill('운영 저장 없이 공개 예시로 확인합니다.');
  await page.getByLabel('실행 대상 선택', { exact: true }).click();
  await page.getByTestId('execution-agent-public-agent').click();
  await page.getByLabel('실행 대상 확인', { exact: true }).click();
  await shot('card-memory-save');
  await page.getByLabel('카드 저장', { exact: true }).click();
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });
  evidence.samples.push({ name, sample: 'card-create', saved: true });
  await open('folder-create');
  await page.getByPlaceholder('폴더 이름', { exact: true }).fill('메모리 폴더');
  await page.getByTestId('new-task-submit').click();
  await page.getByTestId('review-dialogue-result').waitFor();
  assert.match(await page.getByTestId('review-dialogue-result').textContent(), /메모리 폴더/);
  evidence.samples.push({ name, sample: 'folder-create', saved: true });
  await open('session-create');
  await page.getByPlaceholder('세션을 시작하자마자 수행할 지시…', { exact: true }).fill('메모리 세션');
  await page.getByTestId('succession-submit').click();
  await page.getByTestId('review-dialogue-result').waitFor();
  assert.match(await page.getByTestId('review-dialogue-result').textContent(), /메모리 세션/);
  evidence.samples.push({ name, sample: 'session-create', saved: true });
  }
  const beforeOverlay = await metrics(page);
  for (const kind of verifySaves ? ['카드', '폴더', '세션'] : ['카드']) {
    await page.getByLabel(kind + ' 상세 오버레이 열기', { exact: true }).click();
    await page.getByTestId('task-workspace-sheet').waitFor();
    await page.waitForFunction(() => Math.abs(document.querySelector('[data-testid="task-workspace-sheet"]').getBoundingClientRect().x - innerWidth * .1) < 1 || innerWidth > 1022 && Math.abs(document.querySelector('[data-testid="task-workspace-sheet"]').getBoundingClientRect().x - (innerWidth - 920)) < 1);
    if (kind === '카드' && !verifySaves) {
      const image = page.getByTestId('card-report-thumbnail-public-image-report-0');
      await image.click();
      await page.getByTestId('image-viewer-pages').waitFor();
      await shot('detail-image-viewer');
      await page.getByLabel('이미지 닫기', { exact: true }).click();
      await page.getByTestId('image-viewer-pages').waitFor({ state: 'hidden' });
      await page.getByTestId('card-fold-report-public-image-report').click({ position: { x: 20, y: 20 } });
      await page.getByTestId('image-viewer-pages').waitFor({ state: 'hidden' });
      const scroll = page.getByTestId('card-detail-scroll');
      const scrolling = await scroll.evaluate(el => { el.scrollTop = 0; const before = el.scrollTop; el.scrollTop = el.scrollHeight; return { before, after: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }; });
      assert.ok(scrolling.after > scrolling.before && scrolling.scrollHeight > scrolling.clientHeight);
      evidence.narrowDetailScroll = scrolling;
      await shot('detail-scroll');
      await page.getByLabel('뒤로', { exact: true }).click();
      await page.getByTestId('task-workspace-sheet').waitFor({ state: 'detached' });
      await page.getByLabel('카드 상세 오버레이 열기', { exact: true }).click();
      await page.getByTestId('card-detail-header').waitFor();
      await page.waitForFunction(() => Math.abs(document.querySelector('[data-testid="task-workspace-sheet"]').getBoundingClientRect().x - 39) < 1);
      evidence.reopenedDetail = true;
    }
    await shot(kind === '카드' ? 'card-overlay' : kind === '폴더' ? 'folder-overlay' : 'session-overlay');
    await page.getByTestId('task-workspace-backdrop-close').click({ position: { x: 1, y: 1 } });
    await page.getByTestId('task-workspace-sheet').waitFor({ state: 'detached' });
    evidence.samples.push({ name, sample: kind + ' overlay', opened: true, closed: true });
  }
  const sentinels = await page.evaluate(() => [localStorage.getItem('soul-app-settings'), localStorage.getItem('soul-auth')]);
  assert.deepEqual(sentinels, ['public-sentinel-settings', 'public-sentinel-auth']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  evidence.viewports.push({ name, beforeOverlay, afterOverlay: await metrics(page) });
  await context.close();
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const base = 'http://127.0.0.1:' + server.address().port;
    if (remaining === '--measure-before') { await measureBefore(browser, base); return; }
    await capture(browser, base, 'phone', { width: 390, height: 844 }, !['--remaining', '--final'].includes(remaining), remaining !== '--final');
    await capture(browser, base, 'tablet', { width: 1024, height: 768 });
    assert.deepEqual(evidence.errors, []);
    assert.ok(evidence.requests.every(request => request.method === 'GET' && request.path === '/api/auth/status'));
    evidence.passed = true; console.log(JSON.stringify(evidence, null, 2));
  } catch (error) { evidence.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
