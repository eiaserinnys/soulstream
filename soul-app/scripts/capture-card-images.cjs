// Run under heavy_verify. Local fixture cookies prove browser rendering only;
// native Authorization source contracts and production HTTP are separate gates.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

function assertStableWidth(rects) {
  for (const rect of rects.slice(1)) assert(Math.abs(rect.width - rects[0].width) <= 1, 'report fold width must stay within 1px');
}
if (process.argv[2] === '--self-test') {
  assertStableWidth([{ width: 300 }, { width: 300.5 }, { width: 300 }]);
  assert.throws(() => assertStableWidth([{ width: 300 }, { width: 90 }, { width: 300 }]), /report fold width/);
  assert.throws(() => assertStableWidth([{ width: 300 }, { width: 300 }, { width: 90 }]), /report fold width/);
  console.log('report width checker: stable accepted, expanded and refolded shrink rejected');
  process.exit(0);
}

const [playwrightPath, beforeRoot, afterRoot, evidenceRoot, browserPath, scope] = process.argv.slice(2);
if (!browserPath) throw new Error('Playwright, before/after bundle, evidence, browser paths required');
const { chromium } = require(path.resolve(playwrightPath));
const appRoot = path.resolve(__dirname, '..');
const output = path.resolve(evidenceRoot);
const prefix = '/assets/card-image-review/';
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
let root;
const requests = [];
const result = { passed: false, browserScope: 'RN web with local fixture cookie; no native claim', cases: [], errors: [], requests };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const authenticated = req.headers.cookie?.includes('review=fixture') === true;
  if (url.pathname === '/api/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated })); return;
  }
  let file;
  if (url.pathname === '/api/attachments/files') {
    requests.push({ path: url.pathname, cookie: authenticated, authorization: Boolean(req.headers.authorization) });
    if (!authenticated) { res.writeHead(401); res.end(); return; }
    file = path.join(appRoot, 'assets', url.searchParams.get('path') === '/review/two.png' ? 'icon-symbol.png' : 'icon.png');
  } else if (url.pathname === '/public-image.png') {
    requests.push({ path: url.pathname, authorization: Boolean(req.headers.authorization) });
    file = path.join(appRoot, 'assets/icon.png');
  } else if (url.pathname.startsWith(prefix)) {
    file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  } else { res.writeHead(404); res.end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});

async function run(browser, base, mode, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push({ mode, name, message: error.message }));
  await page.goto(base + prefix + 'index.html');
  await page.getByTestId('card-image-review').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const metric = async locator => locator.evaluate(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      paddingLeft: s.paddingLeft, paddingRight: s.paddingRight, flexGrow: s.flexGrow, maxWidth: s.maxWidth };
  });
  const widthSample = page.getByTestId('review-report-width');
  const widthReport = widthSample.getByTestId('card-fold-report-width-report').getByTestId('assistant-message-bubble');
  const neighborMetrics = async () => {
    const bubbles = widthSample.getByTestId('assistant-message-bubble');
    return { question: await metric(bubbles.nth(0)), comment: await metric(bubbles.nth(2)) };
  };
  await widthSample.scrollIntoViewIfNeeded();
  const collapsed = await metric(widthReport);
  const neighbors = await neighborMetrics();
  await page.screenshot({ path: path.join(output, `${name}-${mode}-width-collapsed.png`) });
  await widthReport.getByText('자세히', { exact: true }).click();
  await widthSample.getByTestId('card-report-markdown-width-report').waitFor();
  await widthReport.getByText('접힌 보고와 펼친 보고의 가로 폭을 비교합니다.', { exact: false }).waitFor();
  const expanded = await metric(widthReport);
  const expandedNeighbors = await neighborMetrics();
  await page.screenshot({ path: path.join(output, `${name}-${mode}-width-expanded.png`) });
  await widthReport.getByText('접기', { exact: true }).click();
  const refolded = await metric(widthReport);
  await page.screenshot({ path: path.join(output, `${name}-${mode}-width-refolded.png`) });
  const shortChat = page.getByTestId('review-unchanged-chat').getByTestId('assistant-message-bubble');
  const shortMessage = await metric(shortChat);
  const widthRecord = { mode, name, viewport, collapsed, expanded, refolded, neighbors, expandedNeighbors, shortMessage };
  if (mode === 'after') {
    assertStableWidth([collapsed, expanded, refolded]);
    assert.equal(expanded.flexGrow, '1');
    for (const key of ['question', 'comment']) {
      for (const field of ['width', 'paddingLeft', 'paddingRight', 'flexGrow', 'maxWidth'])
        assert.equal(expandedNeighbors[key][field], neighbors[key][field], `${key} ${field} must stay unchanged while expanding`);
    }
    const before = result.cases.find(item => item.name === name && item.mode === 'before');
    for (const key of ['question', 'comment', 'shortMessage']) {
      const current = key === 'shortMessage' ? shortMessage : neighbors[key];
      const previous = key === 'shortMessage' ? before.shortMessage : before.neighbors[key];
      for (const field of ['x', 'width', 'paddingLeft', 'paddingRight', 'flexGrow', 'maxWidth'])
        assert.equal(current[field], previous[field], `${key} ${field} must stay unchanged across the fix`);
    }
  }
  if (scope === 'width-only') {
    result.cases.push(widthRecord);
    await context.close();
    return;
  }
  const report = page.getByTestId('review-image-timeline').getByTestId('assistant-message-bubble');
  const shot = part => page.screenshot({ path: path.join(output, name + '-' + mode + '-' + part + '.png') });
  const imagesLoaded = async locator => {
    await locator.evaluate(async el => {
      await Promise.all([...el.querySelectorAll('img')].map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true });
      })));
    });
    return locator.evaluate(el => [...el.querySelectorAll('img')].filter(img => img.naturalWidth > 0).length);
  };
  await imagesLoaded(report);
  await shot('collapsed');
  const record = { ...widthRecord, collapsedImages: await report.locator('[data-testid^="card-report-thumbnail"]').count(), bubble: await metric(report) };
  if (mode === 'after') {
    assert.equal(record.collapsedImages, 2);
    assert.equal(await imagesLoaded(report), 2);
    await page.getByTestId('card-report-thumbnail-public-images-0').click();
    await page.getByTestId('image-viewer-pages').waitFor();
    await imagesLoaded(page.getByTestId('image-viewer-pages'));
    assert.equal(await page.getByTestId('card-report-markdown-public-images').count(), 0, 'image tap must not unfold report');
    await shot('preview-viewer');
    await page.getByLabel('이미지 닫기', { exact: true }).click();
  }
  await report.getByText('자세히', { exact: true }).click();
  if (mode === 'after') {
    const body = page.getByTestId('card-report-markdown-public-images');
    await body.waitFor();
    assert.equal(await report.locator('[data-testid^="card-report-thumbnail"]').count(), 0);
    assert.equal(await report.locator('[data-testid^="card-report-image-public-images-"]').count(), 3);
    assert.equal(await imagesLoaded(body), 3);
    const copy = await body.textContent();
    assert(copy.indexOf('두 이미지 사이') < copy.indexOf('마지막 문단'));
    record.expandedImages = 3;
  }
  await report.scrollIntoViewIfNeeded();
  await shot('expanded');
  if (mode === 'after') {
    await page.getByTestId('card-report-image-public-images-1').click();
    await page.getByTestId('image-viewer-pages').waitFor();
    assert.equal(await page.getByTestId('image-viewer-pages').getByTestId('image-viewer-zoom').count(), 3);
    await shot('body-viewer');
    await page.getByLabel('이미지 닫기', { exact: true }).click();
    assert.equal(await page.getByTestId('card-report-markdown-public-images').count(), 1, 'viewer tap must not fold report');
    await report.getByText('접기', { exact: true }).click();
    assert.equal(await report.locator('[data-testid^="card-report-thumbnail"]').count(), 2);
    for (const label of ['웹 첨부', '앱 첨부']) {
      const image = page.getByLabel(label, { exact: true });
      await image.scrollIntoViewIfNeeded();
      await imagesLoaded(page.getByTestId('review-image-timeline'));
      await image.click();
      await page.getByTestId('image-viewer-pages').waitFor();
      await shot(label === '웹 첨부' ? 'web-comment-viewer' : 'app-comment-viewer');
      await page.getByLabel('이미지 닫기', { exact: true }).click();
    }
  }
  const chat = page.getByTestId('review-unchanged-chat');
  await chat.scrollIntoViewIfNeeded(); await imagesLoaded(chat);
  record.chat = await metric(chat);
  await chat.screenshot({ path: path.join(output, name + '-' + mode + '-chat.png') });
  result.cases.push(record);
  await context.close();
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const [mode, directory] of [['before', beforeRoot], ['after', afterRoot]]) {
      root = path.resolve(directory);
      for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 1194, height: 834 }]])
        await run(browser, base, mode, name, viewport);
    }
    for (const name of scope === 'width-only' ? [] : ['phone', 'tablet']) {
      const before = await fs.readFile(path.join(output, name + '-before-chat.png'));
      const after = await fs.readFile(path.join(output, name + '-after-chat.png'));
      assert(before.equals(after), name + ' existing chat screenshot must be unchanged');
    }
    assert.equal(result.errors.length, 0);
    assert(requests.every(request => !request.authorization), 'RN web should not be treated as a native header gate');
    result.passed = true;
  } catch (error) {
    result.errors.push({ message: error.message }); process.exitCode = 1;
  } finally {
    await fs.writeFile(path.join(output, 'browser-evidence.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, cases: result.cases.length, errors: result.errors }));
    await browser.close(); server.close();
  }
})();
