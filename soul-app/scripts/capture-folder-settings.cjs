// Folder settings, new folder, reference picker, folder context and new session sheets (card #1975).
// Actual RN web export of the component review bundle; run under heavy_verify.py after `npm run export:components`.
// Usage: node scripts/capture-folder-settings.cjs <playwright or playwright-core path> <output dir>
// RN web render, not a device: ActionSheetIOS choices and the native pageSheet width are not drawn here.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const [playwrightPath, outputPath] = process.argv.slice(2);
if (!playwrightPath || !outputPath) throw new Error('Playwright 경로와 산출물 경로가 필요합니다.');
const { chromium } = require(path.resolve(playwrightPath));
const output = path.resolve(outputPath);
const root = path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
const evidence = { passed: false, shots: [], checks: [], errors: [] };
const VIEWPORTS = { iphone: { width: 390, height: 844 }, ipad: { width: 1366, height: 1024 } };
const THEMES = ['light', 'dark'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local');
  if (url.pathname === '/api/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authenticated: true })); return;
  }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(await fs.readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});

function check(name, passed, detail) {
  evidence.checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) evidence.errors.push({ name, detail });
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function openPage(context, base, query, name, readyTestID = 'component-review') {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => evidence.errors.push({ name, message: error.message }));
  await page.goto(base + prefix + 'index.html?' + query);
  await page.getByTestId(readyTestID).first().waitFor();
  return page;
}

async function openSample(page, sample) {
  await page.getByTestId('settings-segment-review-dialogue-' + sample).click();
  await page.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
  await page.getByTestId('app-modal-viewport').waitFor();
  await settle(page);
}

async function scrollSheet(page, testID) {
  await page.getByTestId(testID).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await settle(page);
}

/** Horizontal overflow and clipped text inside the open sheet. */
async function overflow(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="app-modal-viewport"]') ?? document.body;
    const right = viewport.getBoundingClientRect().right + 1;
    const clipped = [...viewport.querySelectorAll('div[dir="auto"], span')]
      .filter((node) => node.childElementCount === 0 && node.textContent.trim())
      .filter((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && (rect.right > right || rect.left < -1); })
      .map((node) => node.textContent.trim().slice(0, 40));
    const zeroWidth = [...viewport.querySelectorAll('div[dir="auto"]')]
      .filter((node) => node.childElementCount === 0 && node.textContent.trim() && node.getBoundingClientRect().width === 0)
      .map((node) => node.textContent.trim().slice(0, 40));
    return { documentOverflow: document.documentElement.scrollWidth > innerWidth, clipped, zeroWidth };
  });
}

async function focusLabel(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return 'body';
    return element.getAttribute('data-testid') || element.getAttribute('aria-label') || element.tagName.toLowerCase();
  });
}

async function captureScenes(browser, base, device, theme) {
  const context = await browser.newContext({ viewport: VIEWPORTS[device], hasTouch: device === 'iphone', locale: 'ko-KR' });
  const query = 'section=dialogues' + (theme === 'dark' ? '&theme=dark' : '');
  const shot = async (page, scene) => {
    const file = `${scene}-${device}-${theme}.png`;
    await page.screenshot({ path: path.join(output, file) });
    evidence.shots.push(file);
  };
  const page = await openPage(context, base, query, `${device}-${theme}`);

  await openSample(page, 'folder-create');
  await shot(page, 'folder-create');
  await page.getByTestId('settings-segment-folder-defaults-own').click();
  await scrollSheet(page, 'new-task-content');
  await shot(page, 'folder-create-bottom');
  await page.keyboard.press('Escape');
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });

  await openSample(page, 'folder-create-root');
  await shot(page, 'folder-create-root');
  await page.keyboard.press('Escape');
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });

  await openSample(page, 'folder-settings');
  await page.getByTestId('folder-settings-guidance').waitFor();
  await shot(page, 'folder-settings');
  await scrollSheet(page, 'new-task-content');
  await shot(page, 'folder-settings-bottom');
  await page.getByTestId('settings-segment-folder-guidance-inherit').click();
  await page.getByTestId('settings-segment-folder-defaults-inherit').click();
  await page.getByTestId('folder-settings-inherited-defaults').waitFor();
  await settle(page);
  await shot(page, 'folder-settings-inherit');
  check(`${device}-${theme} 물려받은 기본 실행 환경 표시 이름`, /공개 예시 에이전트 · public-node · 사용 가능한 예시 모델/.test(
    await page.getByTestId('folder-settings-inherited-defaults').textContent()));
  await page.keyboard.press('Escape');
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });

  await openSample(page, 'reference-picker');
  await page.getByTestId('atom-picker-drill-public-atom-soulstream').click();
  await page.getByTestId('atom-picker-select-public-atom-child-4').click();
  await page.getByTestId('settings-segment-atom-picker-depth-2').click();
  await page.getByTestId('atom-picker-titles-only').click();
  await settle(page);
  await shot(page, 'reference-picker');
  await page.getByTestId('atom-picker-add-selected').click();
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });
  check(`${device}-${theme} 피커 추가 결과`, /프론트엔드 아키텍처/.test(await page.getByTestId('review-dialogue-result').textContent()));

  await openSample(page, 'session-create');
  await page.getByTestId('succession-execution-disclosure').click();
  await settle(page);
  await shot(page, 'session-create');
  await scrollSheet(page, 'succession-content');
  await shot(page, 'session-create-bottom');
  await page.keyboard.press('Escape');
  await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden' });
  await page.close();

  const project = await openPage(context, base, 'section=project' + (theme === 'dark' ? '&theme=dark' : ''), `${device}-${theme}-project`);
  await project.getByTestId('folder-context-summary').waitFor();
  await settle(project);
  await shot(project, 'folder-context');
  await project.getByTestId('settings-segment-review-context-state-loading').click();
  await project.getByTestId('folder-context-summary').waitFor();
  await settle(project);
  await shot(project, 'folder-context-loading');
  check(`${device}-${theme} 맥락 로딩은 같은 틀 안의 진행 표시`, await project.getByRole('progressbar').count() > 0);
  await project.getByTestId('settings-segment-review-context-state-error').click();
  await project.getByTestId('folder-context-retry').waitFor();
  check(`${device}-${theme} 맥락 실패는 같은 틀 안의 안내와 다시 시도`, await project.getByTestId('folder-context-guidance').count() === 0);
  await settle(project);
  await shot(project, 'folder-context-error');
  await project.close();

  const workspace = await openPage(context, base, 'section=folderWorkspace' + (theme === 'dark' ? '&theme=dark' : ''), `${device}-${theme}-workspace`, 'folder-context-summary');
  await workspace.getByTestId('folder-context-summary').waitFor();
  await workspace.getByTestId('planner-section-header-context').scrollIntoViewIfNeeded();
  await settle(workspace);
  await shot(workspace, 'folder-workspace-context');
  check(`${device}-${theme} 폴더 화면에 프로젝트 컨텍스트 절이 없다`, await workspace.getByText('프로젝트 컨텍스트', { exact: true }).count() === 0);
  check(`${device}-${theme} 폴더 화면에 비활성 추가가 없다`, await workspace.getByTestId('task-workspace-add-context').count() === 0);
  await workspace.close();
  await context.close();
}

/** §0 14-18: focus, Tab and Esc, the narrowest width, failure state, resize. */
async function measureOperations(browser, base) {
  const context = await browser.newContext({ viewport: VIEWPORTS.ipad, locale: 'ko-KR' });
  const page = await openPage(context, base, 'section=dialogues', 'operations');
  const operations = { dialogs: [] };

  for (const [sample, firstField] of [['folder-create', 'folder-settings-title'], ['folder-settings', null], ['reference-picker', null], ['session-create', null]]) {
    await page.getByTestId('settings-segment-review-dialogue-' + sample).click();
    const opener = page.getByLabel('선택한 다이얼로그 열기', { exact: true });
    await opener.click();
    await page.getByTestId('app-modal-viewport').waitFor();
    await settle(page);
    const openedFocus = await focusLabel(page);
    const tabs = [];
    for (let index = 0; index < 6; index += 1) { await page.keyboard.press('Tab'); tabs.push(await focusLabel(page)); }
    await page.keyboard.press('Escape');
    const closed = await page.getByTestId('app-modal-viewport').waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
    const closedFocus = await focusLabel(page);
    operations.dialogs.push({ sample, openedFocus, firstField, tabs, escapeCloses: closed, closedFocus });
    check(`${sample} Esc로 닫힌다`, closed);
    if (firstField) check(`${sample} 첫 초점이 이름 칸`, openedFocus === firstField, openedFocus);
  }

  await page.getByTestId('settings-segment-review-dialogue-folder-settings').click();
  await page.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
  await page.getByTestId('folder-settings-guidance').waitFor();
  await page.getByTestId('folder-settings-guidance').fill('넓은 폭에서 쓰던 지침');
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const afterResize = await page.getByTestId('folder-settings-guidance').inputValue();
  const resized = await overflow(page);
  operations.resize = { from: VIEWPORTS.ipad, to: { width: 390, height: 844 }, keptInput: afterResize, ...resized };
  check('창을 좁혀도 입력 중인 지침이 남는다', afterResize === '넓은 폭에서 쓰던 지침', afterResize);
  check('창을 좁혀도 가로 넘침이 없다', !resized.documentOverflow && resized.clipped.length === 0, resized);
  await page.screenshot({ path: path.join(output, 'folder-settings-resized-390.png') });
  evidence.shots.push('folder-settings-resized-390.png');

  await page.setViewportSize({ width: 360, height: 780 });
  await settle(page);
  const narrow = await overflow(page);
  operations.narrow = { width: 360, ...narrow };
  check('360 폭에서 가로 넘침과 잘린 글이 없다', !narrow.documentOverflow && narrow.clipped.length === 0 && narrow.zeroWidth.length === 0, narrow);
  await page.screenshot({ path: path.join(output, 'folder-settings-360.png') });
  evidence.shots.push('folder-settings-360.png');
  await page.close();
  await context.close();
  await fs.writeFile(path.join(output, 'operations.json'), JSON.stringify(operations, null, 2));
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const device of Object.keys(VIEWPORTS)) {
      for (const theme of THEMES) await captureScenes(browser, base, device, theme);
    }
    await measureOperations(browser, base);
    assert.deepEqual(evidence.errors, []);
    evidence.passed = true;
  } catch (error) { evidence.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ passed: evidence.passed, shots: evidence.shots.length, errors: evidence.errors, failure: evidence.failure }, null, 2));
    await browser?.close(); await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
