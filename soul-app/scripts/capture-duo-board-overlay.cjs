// 아이폰 듀오 바깥 화면의 데일리 보드가 오른쪽 시스템 레일 아래까지 이어지는지 검수한다.
// Run under heavy_verify.py. Playwright is supplied by the caller; it is not an
// app runtime dependency. Only this process's local fixture server is contacted.
//
// 사용:
//   node scripts/export-components.mjs            # 현재 HEAD의 검수 번들 생성
//   node scripts/capture-duo-board-overlay.cjs <playwrightPath> <evidencePath> <bundleRoot> [phase]
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const [playwrightPath, evidencePath, bundleRoot, phase = 'after'] = process.argv.slice(2);
if (!playwrightPath || !evidencePath || !bundleRoot) {
  throw new Error('사용: capture-duo-board-overlay.cjs <playwrightPath> <evidencePath> <bundleRoot> [phase]');
}
const { chromium } = require(path.resolve(playwrightPath));
const root = path.resolve(bundleRoot);
const output = path.resolve(evidencePath);
const prefix = '/assets/ios-components/';
const result = { passed: false, phase, frames: [], interactions: [], errors: [], warnings: [] };
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local.test');
  if (url.pathname.startsWith('/api/')) {
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

const frameList = [
  { id: 'outer-portrait', width: 466, height: 678 },
  { id: 'outer-landscape', width: 678, height: 466 },
];

// 좌표는 프레임 루트 기준 getBoundingClientRect 값이다.
function measure() {
  const box = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
  };
  const byTestId = (testId) => document.querySelector(`[data-testid="${testId}"]`);
  const scroll = byTestId('card-board');
  const columns = [...document.querySelectorAll('[data-testid^="card-board-column-"]')];
  const tabs = [...document.querySelectorAll('[data-testid^="phone-tab-"], [data-testid^="phone-rail-"]')];
  return {
    window: { width: innerWidth, height: innerHeight },
    boardFrame: box(byTestId('card-board-frame')),
    board: box(scroll),
    boardScroll: scroll ? { left: Math.round(scroll.scrollLeft), max: Math.round(scroll.scrollWidth - scroll.clientWidth) } : null,
    columns: columns.map((column) => ({ testId: column.dataset.testid, ...box(column) })),
    railItems: tabs.map((tab) => ({ testId: tab.dataset.testid, ...box(tab) })),
    composerDock: box(byTestId('home-session-composer-dock')),
    composerTrigger: box(byTestId('home-session-composer-trigger')),
    refreshIndicator: box(byTestId('card-board-auto-progress')),
    dailyContent: box(byTestId('card-home-content')),
    folderRoot: box(byTestId('folder-list-screen')),
    feedBody: box(byTestId('phone-feed-body')),
    settingsRoot: box(byTestId('settings-safe-area')),
    pasRoot: box(byTestId('persistent-session-screen')),
    cardDetail: box(document.querySelector('[data-testid^="card-detail"], [data-testid="folder-workspace-read-overlay"]')),
  };
}

// 레일 띠 안에서 카드가 아닌 빈 지점을 찾는다. 그 지점의 히트 대상이 보드여야 관통이 증명된다.
function findEmptyRailPoint({ sidebarLeft, width }) {
  const hits = [];
  for (let x = sidebarLeft + 6; x < width - 4; x += 12) {
    for (let y = 90; y < innerHeight - 140; y += 10) {
      const element = document.elementFromPoint(x, y);
      if (!element) continue;
      const card = element.closest('[data-testid^="postit-card-"], [data-testid^="board-card-gesture-"]');
      const rail = element.closest('[data-testid="phone-rail-tab-rail"]');
      const board = element.closest('[data-testid="card-board-frame"]');
      if (!rail && board && !card) {
        hits.push({ x, y, testId: element.dataset?.testid ?? null, card: card?.dataset?.testid ?? null });
      }
    }
  }
  return hits.slice(0, 6);
}

async function shot(page, frame, name) {
  const file = path.join(output, `${phase}-${name}-${frame.id}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: frame.width, height: frame.height } });
  return file;
}

async function captureScreen(page, frame, name, url) {
  await page.goto(url);
  await page.getByTestId('card-board-frame').waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  const metrics = await page.evaluate(measure);
  const screenshot = await shot(page, frame, name);
  return { name, url, screenshot, metrics };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const frame of frameList) {
      const context = await browser.newContext({ viewport: { width: frame.width, height: frame.height }, deviceScaleFactor: 2 });
      await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', (error) => result.errors.push(`${frame.id}: ${error.message}`));
      await page.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const pageUrl = (query) => `${base}${prefix}index.html?section=iphoneDuo&sample=main-layout&frame=${frame.id}&${query}`;
      const entries = [];
      entries.push(await captureScreen(page, frame, 'daily-default', pageUrl('tab=DailyTab&board=ops')));
      // 기본 위치에서 맨 끝 열까지 스크롤한다. 스냅 오프셋과 끝 스크롤 한계를 잰다.
      await page.evaluate(() => {
        const board = document.querySelector('[data-testid="card-board"]');
        if (board) board.scrollLeft = board.scrollWidth;
      });
      await page.waitForTimeout(700);
      const endMetrics = await page.evaluate(measure);
      entries.push({ name: 'daily-end', screenshot: await shot(page, frame, 'daily-end'), metrics: endMetrics });
      entries.push(await captureScreen(page, frame, 'daily-loading', pageUrl('tab=DailyTab&board=loading')));
      entries.push(await captureScreen(page, frame, 'folder', pageUrl('tab=FolderTab&board=ops')));
      entries.push(await captureScreen(page, frame, 'feed', pageUrl('tab=FeedTab&board=ops')));
      entries.push(await captureScreen(page, frame, 'pas', pageUrl('tab=PersistentTab&board=ops')));
      entries.push(await captureScreen(page, frame, 'settings', pageUrl('tab=SettingsTab&board=ops')));
      entries.push(await captureScreen(page, frame, 'card-detail', pageUrl('view=card-detail&board=ops')));
      result.frames.push({ frame: frame.id, entries });
      const sidebarLeft = frame.width - 84;
      const overlay = phase !== 'before';
      const daily = entries.find((entry) => entry.name === 'daily-default');
      // before는 기준선 기록만 한다. 보드가 화면 끝까지 오는 것은 after의 기대값이다.
      result.baselines = { ...(result.baselines ?? {}), [frame.id]: {
        boardRight: daily.metrics.boardFrame?.right ?? null,
        composerDockRight: daily.metrics.composerDock?.right ?? null,
      } };
      if (overlay && daily.metrics.boardFrame) {
        assert.ok(Math.abs(daily.metrics.boardFrame.right - frame.width) <= 1, `보드 오른쪽 끝이 화면 끝이 아니다: ${daily.metrics.boardFrame.right}`);
      }
      const lastColumn = endMetrics.columns[endMetrics.columns.length - 1];
      if (lastColumn) {
        assert.ok(lastColumn.right <= sidebarLeft + 1, `끝 열이 사이드바 경계를 넘었다: ${lastColumn.right} > ${sidebarLeft}`);
      }
      const composerRight = daily.metrics.composerDock?.right ?? daily.metrics.composerTrigger?.right;
      if (composerRight !== undefined) {
        assert.ok(Math.abs(composerRight - (sidebarLeft - 16)) <= 20, `새 대화 도크가 사이드바 안으로 들어갔다: ${composerRight}`);
      }
      // 레일 띠 관통과 캡슐 누름은 after에서만 의미가 있다(before에는 띠 아래에 보드가 없다).
      if (overlay && frame.id === 'outer-portrait') {
        // 1) 레일 캡슐 버튼이 눌린다.
        await page.goto(pageUrl('tab=DailyTab&board=ops'));
        await page.getByTestId('card-board-frame').waitFor();
        await page.waitForTimeout(700);
        const folderTab = page.getByTestId('phone-tab-FolderTab');
        await folderTab.click();
        await page.getByTestId('folder-list-screen').waitFor();
        const folderMetrics = await page.evaluate(measure);
        assert.ok(folderMetrics.folderRoot && folderMetrics.folderRoot.right <= sidebarLeft + 1, '폴더 탭 내용이 사이드바 아래로 들어갔다');
        await page.getByTestId('phone-tab-DailyTab').click();
        await page.getByTestId('card-home-content').waitFor();
        result.interactions.push({ name: 'rail-button', passed: true, folderContentRight: folderMetrics.folderRoot?.right });
        // 2) 캡슐 사이 빈 레일 띠는 보드로 관통한다. 누르면 화면이 바뀌지 않는다.
        const points = await page.evaluate(findEmptyRailPoint, { sidebarLeft, width: frame.width });
        assert.ok(points.length > 0, '레일 띠에서 보드로 관통하는 빈 지점을 찾지 못했다');
        const point = points[0];
        await page.mouse.click(point.x, point.y);
        await page.waitForTimeout(400);
        const afterClick = await page.evaluate(measure);
        assert.ok(afterClick.dailyContent, '빈 레일 띠 클릭 뒤 데일리 화면이 사라졌다');
        // 3) 빈 레일 띠에서 시작한 가로 끌기가 보드를 움직인다.
        await page.goto(pageUrl('tab=DailyTab&board=ops'));
        await page.getByTestId('card-board-frame').waitFor();
        await page.waitForTimeout(700);
        const beforeDrag = await page.evaluate(measure);
        const dragPoints = await page.evaluate(findEmptyRailPoint, { sidebarLeft, width: frame.width });
        const dragPoint = dragPoints[0];
        assert.ok(dragPoint, '레일 띠에서 끌기를 시작할 빈 지점을 찾지 못했다');
        await page.mouse.move(dragPoint.x, dragPoint.y);
        await page.mouse.down();
        await page.mouse.move(dragPoint.x - 180, dragPoint.y, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        const afterDrag = await page.evaluate(measure);
        assert.ok(afterDrag.boardScroll && beforeDrag.boardScroll, '보드 스크롤 상태를 읽지 못했다');
        assert.ok(afterDrag.boardScroll.left > beforeDrag.boardScroll.left + 40,
          `레일 띠에서 시작한 끌기가 보드를 움직이지 않았다: ${beforeDrag.boardScroll.left} → ${afterDrag.boardScroll.left}`);
        result.interactions.push({ name: 'rail-empty-click', passed: true, point, hit: point.testId });
        result.interactions.push({ name: 'rail-empty-drag', passed: true, point: dragPoint,
          scrollBefore: beforeDrag.boardScroll.left, scrollAfter: afterDrag.boardScroll.left });
      }
      await context.close();
    }
    result.passed = true;
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(async () => {
  await fs.writeFile(path.join(output, `${phase}-duo-board-overlay.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, phase: result.phase, frames: result.frames.map((frame) => frame.frame),
    baselines: result.baselines, interactions: result.interactions, errors: result.errors }, null, 2));
  process.exit(0);
}).catch(async (error) => {
  result.errors.push(String(error?.message ?? error));
  await fs.mkdir(output, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(output, `${phase}-duo-board-overlay.json`), JSON.stringify(result, null, 2)).catch(() => {});
  console.error(error);
  process.exit(1);
});
