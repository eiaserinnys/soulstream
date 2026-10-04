// Run after npm run export:components. Uses the existing Vite route and the
// real React Native web export inside its component-review iframe.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [playwrightPath, evidencePath, viteRootPath] = process.argv.slice(2);
if (!playwrightPath || !evidencePath || !viteRootPath) throw new Error('Playwright, 증거 경로, 기존 Vite 경로가 필요합니다.');
const { chromium } = require(path.resolve(playwrightPath));
const dashboard = path.resolve(process.cwd(), '../unified-dashboard');
const viteRoot = path.resolve(viteRootPath);
const root = path.join(dashboard, 'dist/assets/ios-components');
const output = path.resolve(evidencePath);
const prefix = '/assets/ios-components/';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
const evidence = { passed: false, scenarios: [], errors: [] };
let base;

function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(read, predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(40);
  }
  throw new Error('Timed out waiting for ' + description);
}

function summarizeRequests(requests) {
  const counts = new Map();
  for (const request of requests) counts.set(String(request.cursor), (counts.get(String(request.cursor)) ?? 0) + 1);
  return {
    calls: requests,
    cursorOrder: requests.map(request => request.cursor),
    duplicateCursors: [...counts].filter(([, count]) => count > 1).map(([cursor, count]) => ({ cursor, count })),
  };
}

async function runScenario(browser, scenario) {
  const viewport = scenario === 'many' ? { width: 430, height: 740 } : { width: 430, height: 1100 };
  const page = await browser.newPage({ viewport });
  try {
    await runScenarioPage(page, scenario, viewport);
  } finally {
    await page.close();
  }
}

async function runScenarioPage(page, scenario, viewport) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => evidence.errors.push({ scenario, message: error.message }));
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/status') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true }) });
    } else {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ preferences: { appearance: 'light', glass: { enabled: false } }, authEnabled: true, devModeEnabled: false }) });
    }
  });
  await page.route('**/assets/ios-components/**', async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
    assert.ok(file.startsWith(root + path.sep), 'asset path remains under the existing component export');
    await route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) });
  });
  await page.goto(base + '/components/ios');
  const iframe = page.locator('iframe');
  await iframe.waitFor();
  await iframe.evaluate((element, src) => { element.src = src; },
    prefix + `index.html?section=folderWorkspace&folderSessionPages=${scenario}`);
  const frame = await waitFor(
    () => page.frames().find(candidate => candidate.url().includes(`folderSessionPages=${scenario}`)),
    candidate => !!candidate,
    `${scenario} React Native iframe navigation`,
  );
  const list = frame.getByTestId('task-workspace-scroll');
  await list.waitFor();
  const pageSize = scenario === 'many' ? 20 : 2;
  const firstLastId = `public-folder-${scenario}-${String(pageSize).padStart(2, '0')}`;
  await frame.getByTestId(`task-run-row-${firstLastId}`).waitFor();
  const initial = await frame.evaluate(() => ({
    requests: window.__folderSessionPageRequests ?? [],
    rows: [...document.querySelectorAll('[data-testid^="task-run-depth-"]')].map(row => ({
      id: row.getAttribute('data-testid'), top: row.getBoundingClientRect().top,
      bottom: row.getBoundingClientRect().bottom,
    })),
    list: (() => {
      const owner = document.querySelector('[data-testid="task-workspace-scroll"]');
      const style = owner && getComputedStyle(owner);
      return owner ? { rect: owner.getBoundingClientRect().toJSON(), scrollTop: owner.scrollTop,
        scrollHeight: owner.scrollHeight, clientHeight: owner.clientHeight, overflowY: style?.overflowY,
        viewport: { width: window.innerWidth, height: window.innerHeight } } : null;
    })(),
  }));
  const scenarioEvidence = {
    scenario, viewport, stage: 'initial-render',
    initialRequests: summarizeRequests(initial.requests),
    initialRowIds: initial.rows.map(row => row.id),
    initialRows: initial.rows,
    initialGeometry: initial.list,
  };
  evidence.scenarios.push(scenarioEvidence);

  if (scenario === 'many') {
    scenarioEvidence.initialRequestAssertion = {
      expected: [null], actual: initial.requests.map(request => request.cursor),
    };
    assert.deepEqual(initial.requests.map(request => request.cursor), [null], 'many: first page is the only request before input');
    const listBox = await list.boundingBox();
    assert.ok(listBox, 'FlatList has a visible viewport');
    const scrollStart = await frame.evaluate(() => {
      const root = document.querySelector('[data-testid="task-workspace-scroll"]');
      const isScrollOwner = element => {
        const style = getComputedStyle(element);
        return element.clientHeight > 0 && element.scrollHeight > element.clientHeight && /auto|scroll/.test(style.overflowY);
      };
      const descendants = [...(root?.querySelectorAll('*') ?? [])];
      const ancestors = [];
      for (let parent = root?.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
      const owner = (root && isScrollOwner(root) ? root : null)
        ?? descendants.find(isScrollOwner)
        ?? ancestors.find(isScrollOwner);
      if (!owner) return null;
      window.__folderSessionScrollOwner = owner;
      return { testId: owner.getAttribute('data-testid'), tag: owner.tagName,
        scrollTop: owner.scrollTop, scrollHeight: owner.scrollHeight, clientHeight: owner.clientHeight,
        overflowY: getComputedStyle(owner).overflowY, rect: owner.getBoundingClientRect().toJSON() };
    });
    scenarioEvidence.scrollOwnerStart = scrollStart;
    scenarioEvidence.stage = 'scroll-owner-measured';
    assert.ok(scrollStart, 'the actual FlatList scroll owner is identified before input');
    const wheelDelta = Math.max(1, Math.ceil(scrollStart.scrollHeight - scrollStart.scrollTop
      - scrollStart.clientHeight + scrollStart.clientHeight * 0.5 + 1));
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.mouse.wheel(0, wheelDelta);
    const readScrollOwner = () => frame.evaluate(() => {
      const owner = window.__folderSessionScrollOwner;
      return owner ? { testId: owner.getAttribute('data-testid'), tag: owner.tagName,
        scrollTop: owner.scrollTop, scrollHeight: owner.scrollHeight, clientHeight: owner.clientHeight,
        remaining: owner.scrollHeight - (owner.scrollTop + owner.clientHeight),
        rect: owner.getBoundingClientRect().toJSON() } : null;
    });
    let scrollAfterWheel;
    let wheelThresholdError;
    try {
      scrollAfterWheel = await waitFor(readScrollOwner,
        metrics => metrics && metrics.scrollTop > scrollStart.scrollTop
          && metrics.remaining <= metrics.clientHeight * 0.5,
        'actual wheel input to reach the FlatList near-end threshold');
    } catch (error) {
      wheelThresholdError = error;
      scrollAfterWheel = await readScrollOwner();
    }
    const wheelDiagnostics = { owner: scrollStart, wheelDelta, afterWheel: scrollAfterWheel };
    scenarioEvidence.wheel = { type: 'page.mouse.wheel', deltaX: 0, deltaY: wheelDelta };
    scenarioEvidence.scrollAfterWheel = scrollAfterWheel;
    scenarioEvidence.stage = wheelThresholdError ? 'wheel-sent-threshold-not-reached' : 'end-threshold-reached';
    const wheelScreenshot = path.join(output, 'many-after-wheel.png');
    await page.screenshot({ path: wheelScreenshot, animations: 'disabled' });
    scenarioEvidence.wheelScreenshot = wheelScreenshot;
    if (wheelThresholdError) {
      throw wheelThresholdError;
    }
    const requestLog = () => frame.evaluate(() => window.__folderSessionPageRequests ?? []);
    let afterScroll;
    try {
      afterScroll = await waitFor(requestLog,
        requests => requests.some(request => request.cursor === '1'), 'second cursor request after wheel input');
    } catch (error) {
      scenarioEvidence.requestsWhenCursor1TimedOut = summarizeRequests(await requestLog());
      scenarioEvidence.stage = 'cursor-1-request-timeout';
      throw error;
    }
    const sequence = ['scroll-owner-and-start-measured', 'calculated-wheel-sent', 'end-threshold-reached', 'cursor-1-requested'];
    const scrollMetrics = await frame.evaluate(() => {
      const owner = window.__folderSessionScrollOwner;
      const rect = owner?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-testid^="task-run-depth-"]')];
      const visible = rows.map(row => ({
        id: row.getAttribute('data-testid'), top: row.getBoundingClientRect().top,
        bottom: row.getBoundingClientRect().bottom,
      })).find(row => rect && row.bottom > rect.top && row.top < rect.bottom);
      return { scrollTop: owner?.scrollTop ?? 0, scrollHeight: owner?.scrollHeight ?? 0,
        clientHeight: owner?.clientHeight ?? 0, owner: owner?.getAttribute('data-testid') ?? owner?.tagName,
        anchor: visible };
    });
    scenarioEvidence.requestsAfterWheel = summarizeRequests(afterScroll);
    scenarioEvidence.scrollMetricsBeforePage2Release = scrollMetrics;
    scenarioEvidence.anchorBeforeAppend = scrollMetrics.anchor;
    scenarioEvidence.stage = 'cursor-1-requested-gate-held-anchor-captured';
    assert.ok(scrollMetrics.scrollTop > 0, 'mouse wheel moved the real scroll owner');
    assert.ok(scrollMetrics.anchor, 'a session row remains visible while the next page is pending');
    const beforeAppend = scrollMetrics.anchor;
    const requestsForCursor = afterScroll.filter(request => request.cursor === '1').length;
    const screenshot = path.join(output, 'many-before-page-2.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    scenarioEvidence.beforePage2Screenshot = screenshot;
    sequence.push('visible-row-offset-captured-before-page-2-release');
    await frame.evaluate(() => {
      (window.__releaseFolderSessionPageTwo ?? []).forEach(release => release());
    });
    sequence.push('page-2-response-released');
    scenarioEvidence.stage = 'page2-response-released';
    const lastId = 'public-folder-many-40';
    try {
      await frame.getByTestId(`task-run-row-${lastId}`).waitFor();
    } catch (error) {
      scenarioEvidence.requestsWhenRow40TimedOut = summarizeRequests(await requestLog());
      scenarioEvidence.rowIdsWhenRow40TimedOut = await frame.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="task-run-depth-"]')].map(row => row.getAttribute('data-testid')));
      scenarioEvidence.stage = 'row-40-timeout-after-page2-release';
      throw error;
    }
    await pause(250);
    const afterAppend = await frame.evaluate(anchorId => {
      const owner = window.__folderSessionScrollOwner;
      const anchor = [...document.querySelectorAll('[data-testid^="task-run-depth-"]')]
        .find(row => row.getAttribute('data-testid') === anchorId);
      const rows = [...document.querySelectorAll('[data-testid^="task-run-depth-"]')];
      return { scrollTop: owner?.scrollTop ?? 0, scrollHeight: owner?.scrollHeight ?? 0,
        clientHeight: owner?.clientHeight ?? 0, rowCount: rows.length,
        rowIds: rows.map(row => row.getAttribute('data-testid')),
        anchor: anchor ? { id: anchor.getAttribute('data-testid'), top: anchor.getBoundingClientRect().top,
          bottom: anchor.getBoundingClientRect().bottom } : null };
    }, beforeAppend.id);
    const allRequests = await requestLog();
    const sameCursorCount = allRequests.filter(request => request.cursor === '1').length;
    const afterScreenshot = path.join(output, 'many-after-page-2.png');
    await page.screenshot({ path: afterScreenshot, animations: 'disabled' });
    const rowIdCounts = new Map();
    for (const rowId of afterAppend.rowIds) rowIdCounts.set(rowId, (rowIdCounts.get(rowId) ?? 0) + 1);
    const duplicateRowIds = [...rowIdCounts].filter(([, count]) => count > 1)
      .map(([rowId, count]) => ({ rowId, count }));
    const uniquePageCount = new Set(allRequests.map(request => request.cursor)).size;
    const row40Id = 'task-run-depth-public-folder-many-40';
    sequence.push('page2-and-followup-state-captured');
    scenarioEvidence.stage = 'all-measurements-captured-before-assertions';
    scenarioEvidence.requestsAfterPage2 = summarizeRequests(allRequests);
    scenarioEvidence.uniquePageCount = uniquePageCount;
    scenarioEvidence.rowsExpectedFromPages = uniquePageCount * pageSize;
    scenarioEvidence.rowCountActual = afterAppend.rowCount;
    scenarioEvidence.rowIdsAfterPage2 = afterAppend.rowIds;
    scenarioEvidence.duplicateRowIds = duplicateRowIds;
    scenarioEvidence.nextPageRow40Id = row40Id;
    scenarioEvidence.nextPageRow40Present = afterAppend.rowIds.includes(row40Id);
    scenarioEvidence.scrollMetricsAfterPage2 = {
      scrollTop: afterAppend.scrollTop, scrollHeight: afterAppend.scrollHeight,
      clientHeight: afterAppend.clientHeight,
    };
    scenarioEvidence.anchorAfterAppend = afterAppend.anchor;
    scenarioEvidence.sameCursor1CallCount = sameCursorCount;
    scenarioEvidence.sameAnchorTopDelta = afterAppend.anchor?.top == null || beforeAppend.top == null
      ? null : afterAppend.anchor.top - beforeAppend.top;
    scenarioEvidence.scrollTopDelta = afterAppend.scrollTop - scrollMetrics.scrollTop;
    scenarioEvidence.screenshots = [wheelScreenshot, screenshot, afterScreenshot];
    scenarioEvidence.sequence = sequence;
    scenarioEvidence.input = { type: 'page.mouse.wheel', deltaY: wheelDelta };
    assert.equal(requestsForCursor, 1, 'one request for cursor 1 is observed when the page begins');
    assert.deepEqual(scenarioEvidence.requestsAfterPage2.duplicateCursors, [], 'no cursor is requested more than once');
    assert.ok(scenarioEvidence.nextPageRow40Present, 'the next-page boundary row is present');
    assert.deepEqual(duplicateRowIds, [], 'no session row ID is rendered more than once');
    assert.equal(afterAppend.rowCount, uniquePageCount * pageSize, 'rendered session rows match unique requested pages');
    assert.ok(Math.abs(afterAppend.scrollTop - scrollMetrics.scrollTop) <= 1, 'page append keeps the scroll offset');
    assert.ok(afterAppend.anchor && Math.abs(afterAppend.anchor.top - beforeAppend.top) <= 1,
      'page append keeps the visible session row at the same viewport offset');
  } else {
    const finalId = 'public-folder-short-06';
    try {
      await frame.getByTestId(`task-run-row-${finalId}`).waitFor();
      await waitFor(() => frame.evaluate(() => window.__folderSessionPageRequests ?? []),
        requests => requests.some(request => request.cursor === '2'), 'third short-list page without input');
    } catch (error) {
      scenarioEvidence.requestsAtShortTimeout = summarizeRequests(await frame.evaluate(() =>
        window.__folderSessionPageRequests ?? []));
      scenarioEvidence.rowIdsAtShortTimeout = await frame.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="task-run-depth-"]')].map(row => row.getAttribute('data-testid')));
      scenarioEvidence.stage = 'short-auto-load-timeout';
      throw error;
    }
    const final = await frame.evaluate(() => {
      const root = document.querySelector('[data-testid="task-workspace-scroll"]');
      const style = root && getComputedStyle(root);
      return { requests: window.__folderSessionPageRequests ?? [],
        rowIds: [...document.querySelectorAll('[data-testid^="task-run-depth-"]')].map(row => row.getAttribute('data-testid')),
        rows: document.querySelectorAll('[data-testid^="task-run-depth-"]').length,
        scrollTop: root?.scrollTop ?? 0, scrollHeight: root?.scrollHeight ?? 0,
        clientHeight: root?.clientHeight ?? 0, overflowY: style?.overflowY };
    });
    const screenshot = path.join(output, 'short-all-pages.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    scenarioEvidence.stage = 'all-measurements-captured-before-assertions';
    scenarioEvidence.requestsFinal = summarizeRequests(final.requests);
    scenarioEvidence.rowIdsFinal = final.rowIds;
    scenarioEvidence.finalRowCount = final.rows;
    scenarioEvidence.scroll = { scrollTop: final.scrollTop, scrollHeight: final.scrollHeight,
      clientHeight: final.clientHeight, overflowY: final.overflowY };
    scenarioEvidence.input = 'none';
    scenarioEvidence.screenshot = screenshot;
    scenarioEvidence.sequence = ['first-page-rendered', 'cursor-1-requested-without-input',
      'cursor-2-requested-without-input', 'all-rows-rendered-at-scrollTop-0'];
    assert.deepEqual(final.requests.map(request => request.cursor), [null, '1', '2']);
    assert.equal(final.rows, 6, 'all three short pages are rendered');
    assert.equal(final.scrollTop, 0, 'short pages loaded without user scrolling');
    scenarioEvidence.stage = 'assertions-passed';
  }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const portServer = require('node:net').createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  base = 'http://127.0.0.1:' + port;
  const vite = spawn(process.execPath, [require('node:fs').realpathSync(path.join(viteRoot, 'node_modules/vite/bin/vite.js')),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: viteRoot, env: { ...process.env, VITE_API_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'],
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
    evidence.scenarioFailures = [];
    for (const scenario of ['many', 'short']) {
      try {
        await runScenario(browser, scenario);
      } catch (error) {
        evidence.scenarioFailures.push({ scenario, message: error.message });
      }
    }
    evidence.passed = evidence.scenarioFailures.length === 0 && evidence.errors.length === 0;
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    evidence.failure = error.message;
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await browser?.close();
    vite.kill('SIGTERM');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
