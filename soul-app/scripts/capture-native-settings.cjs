// Run under heavy_verify.py. Playwright is supplied by the caller; it is not an
// app runtime dependency. Only this process's local fixture server is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const [playwrightPath, evidencePath, phase = 'final'] = process.argv.slice(2);
if (!playwrightPath || !evidencePath) throw new Error('Playwright path와 증거 경로가 필요합니다.');
const { chromium } = require(path.resolve(playwrightPath));
const output = path.resolve(evidencePath);
const root = path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const apiRequests = [];
const result = { passed: false, viewports: [], interactions: [], errors: [], warnings: [], apiRequests };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
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

async function main() {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.goto(`${base}${prefix}index.html?section=rows`);
      await page.getByTestId('review-card-rows').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.getByTestId('review-card-rows').screenshot({ path: path.join(output, `${phase}-unchanged-rows-${viewport.width}.png`) });
      for (const entry of ['modal', 'tab', 'first']) {
        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=${entry}`);
        await page.getByTestId('settings-modal-header').waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (entry === 'first') {
          assert.equal(await page.getByTestId('settings-category-display').isVisible(), false);
          await page.screenshot({ path: path.join(output, `${phase}-${entry}-${viewport.width}.png`) });
          continue;
        }
        await page.screenshot({ path: path.join(output, `${phase}-${entry}-index-${viewport.width}.png`) });
        for (const category of ['display', 'connection', 'backends', 'recurring-jobs', 'review-policy', 'diagnostics']) {
          const selector = page.getByTestId('settings-category-' + category);
          if (!(await selector.isVisible())) {
            const index = page.getByLabel('모든 설정으로 돌아가기', { exact: true });
            if (await index.count()) await index.click();
          }
          assert.equal(await selector.count(), 1, `범주 누락: ${entry}/${category}`);
          await selector.click();
          const detail = category === 'recurring-jobs' ? page.getByTestId('wide-recurring-jobs-panel') : page.getByTestId('settings-detail-' + category);
          await detail.waitFor();
          if (category === 'backends') {
            await page.getByTestId('claude-usage-action').click();
            await page.getByTestId('backend-provider-codex-usage-action').click();
            await page.getByTestId('usage-provider-codex').waitFor();
          }
          if (category === 'recurring-jobs') {
            await page.screenshot({ path: path.join(output, `${phase}-${entry}-jobs-list-${viewport.width}.png`) });
            await page.getByText('새 작업', { exact: true }).click();
            await page.getByLabel('작업 이름', { exact: true }).fill('공개 예시 보존 초안');
            await page.getByLabel('작업 내용', { exact: true }).fill('여러 줄 공개 예시\n두 번째 줄');
            await page.getByTestId('recurring-schedule-mode-monthly').click();
          }
          await page.screenshot({ path: path.join(output, `${phase}-${entry}-${category}-${viewport.width}.png`) });
          if (category === 'connection') {
            const field = page.getByTestId('settings-server-input');
            const savedUrl = await field.inputValue();
            await field.fill('https://preserved-public-example.test');
            await field.focus();
            await page.setViewportSize({ width: viewport.width === 390 ? 1024 : 390, height: viewport.height });
            await field.waitFor();
            assert.equal(await field.inputValue(), 'https://preserved-public-example.test');
            assert.equal(await field.evaluate(el => document.activeElement === el), true);
            await page.setViewportSize(viewport);
            result.interactions.push({ entry, viewport: viewport.width, check: 'reflow retains draft and focus' });
            await field.fill(savedUrl);
          }
          const scroll = category === 'recurring-jobs' ? page.getByTestId('settings-jobs-editor-scroll') : detail;
          if (await scroll.count()) {
            const headerBefore = await page.getByTestId('settings-modal-header').boundingBox();
            const footer = page.getByTestId('settings-active-footer');
            const footerBefore = await footer.count() ? await footer.boundingBox() : null;
            const scrolling = await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight }; });
            assert.deepEqual(await page.getByTestId('settings-modal-header').boundingBox(), headerBefore);
            if (footerBefore) assert.deepEqual(await footer.boundingBox(), footerBefore);
            if (viewport.width === 1024) {
              const sidebar = page.getByTestId('settings-sidebar-scroll');
              if (await sidebar.count()) assert.equal(await sidebar.evaluate(el => el.scrollTop), 0);
            }
            result.interactions.push({ entry, category, viewport: viewport.width, check: 'detail scroll leaves header/footer and sidebar fixed', scrolling });
            await scroll.evaluate(el => { el.scrollTop = 0; });
          }
          if (category === 'recurring-jobs') {
            await page.getByLabel('실행 노드: 선택 안 함', { exact: true }).click();
            await page.getByLabel('실행 노드 검색', { exact: true }).fill('public-node-3');
            await page.waitForTimeout(400); // AppModalSurface's existing slide presentation must settle.
            await page.screenshot({ path: path.join(output, `${phase}-${entry}-selection-sheet-${viewport.width}.png`) });
            await page.getByLabel('public-node-3', { exact: true }).click();
            result.interactions.push({ entry, check: 'searchable target selection' });
          }
          if (category === 'display' && viewport.width === 390) {
            await page.evaluate(() => { window.__reviewTextStyles = []; for (const el of document.querySelectorAll('[dir=auto]')) { window.__reviewTextStyles.push({ el, fontSize: el.style.fontSize, lineHeight: el.style.lineHeight }); const css = getComputedStyle(el); const size = Number.parseFloat(css.fontSize); const height = Number.parseFloat(css.lineHeight); el.style.fontSize = `${size * 2}px`; if (Number.isFinite(height)) el.style.lineHeight = `${height * 2}px`; } });
            await page.screenshot({ path: path.join(output, `${phase}-${entry}-display-text-stress-${viewport.width}.png`) });
            result.interactions.push({ entry, check: 'RN web double-size text stress; native Dynamic Type unverified' });
            await page.evaluate(() => { for (const { el, fontSize, lineHeight } of window.__reviewTextStyles) { el.style.fontSize = fontSize; el.style.lineHeight = lineHeight; } delete window.__reviewTextStyles; });
          }
          const metrics = await page.getByTestId('settings-modal-header').evaluate(el => { const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
          result.viewports.push({ entry, category, viewport, header: metrics });
        }
      }
      for (const state of ['photo-fallback', 'nodes-error', 'usage-error', 'empty']) {
        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=tab&state=${state}`);
        const category = state === 'photo-fallback' ? 'display' : state === 'empty' ? 'recurring-jobs' : 'backends';
        await page.getByTestId(`settings-category-${category}`).click();
        if (state === 'photo-fallback') {
          await page.getByTestId('settings-wallpaper-preview').waitFor();
          await page.evaluate(async () => { await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => undefined))); });
          const tileSource = await page.getByTestId('settings-wallpaper-photo-tile').evaluate(el => getComputedStyle(el).backgroundImage);
          const previewSource = await page.getByTestId('settings-wallpaper-preview').evaluate(el => getComputedStyle(el).backgroundImage);
          assert.equal(tileSource, previewSource);
          result.interactions.push({ viewport: viewport.width, check: 'photo tile and preview resolve the same bundled fallback', sameSource: true });
        }
        if (state === 'nodes-error') { await page.getByText('노드를 불러오지 못했습니다. 다시 시도해 주세요.', { exact: true }).waitFor(); await page.getByText('다시 시도', { exact: true }).click(); }
        if (state === 'usage-error') { await page.getByTestId('claude-usage-action').click(); await page.getByText('사용량 조회 중 오류가 발생했습니다. 다시 시도해 주세요.', { exact: true }).waitFor(); assert.equal(await page.getByTestId('usage-fill-5h').count(), 0); }
        if (state === 'empty') await page.getByText('등록된 반복 작업이 없습니다.', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, `${phase}-state-${state}-${viewport.width}.png`) });
        result.interactions.push({ viewport: viewport.width, check: `actual component ${state}` });
      }
      await context.close();
    }
    result.passed = result.errors.length === 0;
  } finally { await browser.close(); server.close(); await fs.writeFile(path.join(output, `${phase}-browser.json`), JSON.stringify(result, null, 2)); }
  if (!result.passed) throw new Error(result.errors.join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
