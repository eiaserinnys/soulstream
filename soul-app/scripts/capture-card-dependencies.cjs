// 선행 카드(카드 #1865) 앱 화면 검사. export:components가 만든 component-review 번들을
// 로컬 fixture 서버로 띄워 찍고 잰다. 사용법: node scripts/capture-card-dependencies.cjs <출력 폴더>
// Playwright는 unified-dashboard 작업 공간에서 가져온다(앱 의존이 아니다). 측정은 <출력 폴더>/metrics.json,
// 단언이 하나라도 어긋나면 metrics.json을 쓴 뒤 0이 아닌 코드로 끝난다.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const outputArg = process.argv[2];
if (!outputArg) throw new Error('출력 폴더 하나가 필요합니다: node soul-app/scripts/capture-card-dependencies.cjs <출력 폴더>');
const output = path.resolve(outputArg);
const dashboardRequire = createRequire(path.resolve(__dirname, '../../unified-dashboard/package.json'));
const { chromium } = dashboardRequire('@playwright/test');
const root = process.env.COMPONENT_REVIEW_BUNDLE ? path.resolve(process.env.COMPONENT_REVIEW_BUNDLE)
  : path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };

const failures = [];
const metrics = { passed: false, selfTest: {}, apiRequests: [], errors: [], viewports: [] };
const check = (condition, message) => { if (!condition) failures.push(message); return !!condition; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local.test');
  if (url.pathname.startsWith('/api/')) {
    metrics.apiRequests.push({ method: req.method, path: url.pathname });
    if (url.pathname !== '/api/auth/status' || req.method !== 'GET') { res.writeHead(403); res.end('Unexpected API request'); return; }
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

// 장면 이름과 기대 문구는 cardDependencyFixtures.ts의 장면과 한 쌍이다.
const POSTIT_SCENES = {
  wait1: { band: '선행 대기 #1864', tone: 'neutral' },
  wait2: { band: '선행 대기 #1864, #1861', tone: 'neutral' },
  wait3: { band: '선행 대기 #1864 외 2건', tone: 'neutral' },
  cancelled: { band: '선행 취소됨 #1860', tone: 'error' },
  archived: { band: '선행 보관됨 #1858', tone: 'error' },
  longest: { bandStart: '선행 대기 #1855, ', tone: 'neutral', ellipsis: true },
  many: { band: '선행 대기 #1843 외 6건', tone: 'neutral' },
  mixed: { band: '선행 취소됨 #1860', tone: 'error' },
  met: { band: null },
  started: { band: null },
  todo: { band: null },
};
const DETAIL_SCENES = {
  wait1: { count: '0/1', chips: { 'dep-1864-running': '실행 중' } },
  wait2: { count: '0/2', chips: { 'dep-1864-running': '실행 중', 'dep-1861-queued': '대기' } },
  wait3: { count: '1/4', chips: { 'dep-1864-running': '실행 중', 'dep-1861-queued': '대기', 'dep-1859-review': '검수 대기', 'dep-1857-done': '완료' } },
  cancelled: { count: '0/2', chips: { 'dep-1860-cancelled': '취소' }, stopped: ['dep-1860-cancelled'] },
  archived: { count: '0/2', chips: { 'dep-1858-queued': '보관됨' }, stopped: ['dep-1858-queued'] },
  met: { count: '2/2', chips: { 'dep-1857-done': '완료', 'dep-1856-done': '완료' } },
  started: { count: '1/2', chips: { 'dep-1864-running': '실행 중', 'dep-1857-done': '완료' } },
  longest: { count: '0/2', chips: { 'dep-1855-running': '실행 중', 'dep-x-queued': '대기' }, longTitle: ['dep-1855-running', 'dep-x-queued'] },
  many: { count: '3/10', chips: { 'dep-1840-done': '완료', 'dep-1849-running': '실행 중' } },
};
const TABLET_SCENE = { count: '1/4', chips: { 'dep-1857-done': '완료', 'dep-1864-running': '실행 중', 'dep-1860-cancelled': '취소', 'dep-1858-queued': '보관됨' }, stopped: ['dep-1860-cancelled', 'dep-1858-queued'] };
const COLORS = ['yellow', 'pink', 'mint', 'blue', 'lavender'];
const PHONES = [
  { name: 'phone390', width: 390, height: 844 },
  { name: 'phone350', width: 350, height: 760 },
];
const POSTIT_PAGE_HEIGHT = 3600;
const MIN_HIT = 44;
const MIN_TITLE_WIDTH = 96;
const CONTRAST = 4.5;

const luminance = ([r, g, b]) => {
  const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** 화소에서 대비를 잰다: 가장 많은 색이 바탕, 바탕에서 가장 먼 화소가 글자(번진 가장자리라 실제보다 보수적이다). */
async function pixelContrast(analysisPage, png) {
  const pixels = await analysisPage.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const counts = new Map();
    for (let index = 0; index < data.length; index += 4) {
      const key = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { width: image.width, height: image.height, counts: [...counts.entries()] };
  }, png.toString('base64'));
  const decode = (key) => [(key >> 16) & 255, (key >> 8) & 255, key & 255];
  const [backgroundKey] = pixels.counts.sort((a, b) => b[1] - a[1])[0];
  const background = decode(backgroundKey);
  let text = background, best = 1;
  for (const [key] of pixels.counts) {
    const color = decode(key), value = ratio(color, background);
    if (value > best) { best = value; text = color; }
  }
  return { background, text, ratio: Math.round(best * 100) / 100 };
}

/** 판정 코드가 스스로를 증명한다: 위반을 심은 표본에서 빨간불이 켜지는지 먼저 본다. */
async function selfTest(browser) {
  const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
  await page.setContent(`<body style="margin:0;background:#fff;font:14px sans-serif">
    <div id="low" style="width:200px;height:30px;color:#9a9a9a;background:#fff">낮은 대비 글자</div>
    <div id="high" style="width:200px;height:30px;color:#111;background:#fff">충분한 대비 글자</div>
    <div id="clipped" style="width:100px;overflow:hidden;white-space:nowrap">잘려서 말줄임 없이 사라지는 아주 긴 글자입니다</div>
    <div id="ellipsis" style="width:100px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">말줄임으로 끊기는 아주 긴 글자입니다</div>
    <div id="wrapped" style="width:100px;line-height:20px">두 줄로 접히는 아주 긴 글자입니다 두 줄로 접힙니다</div>
    <div id="short" style="width:100px;height:30px">낮은 행</div></body>`);
  const analysis = await browser.newPage();
  const low = await pixelContrast(analysis, await page.locator('#low').screenshot());
  const high = await pixelContrast(analysis, await page.locator('#high').screenshot());
  const fit = (id) => page.evaluate(measureText, id);
  const clipped = await fit('clipped'), ellipsis = await fit('ellipsis'), wrapped = await fit('wrapped');
  metrics.selfTest = { low: low.ratio, high: high.ratio,
    clipped: judgeText(clipped), ellipsis: judgeText(ellipsis), wrapped: judgeText(wrapped), shortRowFlagged: 30 < MIN_HIT };
  check(low.ratio < CONTRAST, `자체 시험: 낮은 대비 표본이 4.5 미만으로 잡히지 않음 (${low.ratio})`);
  check(high.ratio >= CONTRAST, `자체 시험: 높은 대비 표본이 4.5 이상으로 잡히지 않음 (${high.ratio})`);
  check(metrics.selfTest.clipped === 'clipped', `자체 시험: 말줄임 없이 잘린 글자가 잡히지 않음 (${metrics.selfTest.clipped})`);
  check(metrics.selfTest.ellipsis === 'ellipsized', `자체 시험: 말줄임 글자 판정 실패 (${metrics.selfTest.ellipsis})`);
  check(metrics.selfTest.wrapped === 'wrapped', `자체 시험: 줄바꿈 글자가 잡히지 않음 (${metrics.selfTest.wrapped})`);
  await page.close(); await analysis.close();
}

/** 브라우저 안에서 도는 글자 측정. 줄 수는 getClientRects, 말줄임은 스타일, 잘림은 scrollWidth로 본다. */
function measureText(testId) {
  const element = document.getElementById(testId) ?? document.querySelector(`[data-testid="${testId}"]`);
  if (!element) return { missing: true };
  const style = getComputedStyle(element);
  const range = document.createRange();
  range.selectNodeContents(element);
  const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
  const rect = element.getBoundingClientRect();
  // 줄 높이가 px로 정해져 있으면 안쪽 높이로 줄 수를 센다(아이콘 글리프가 섞인 칩은 글자 상자 위치가 줄마다 달라 보인다).
  const lineHeight = parseFloat(style.lineHeight);
  const inner = rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const lines = Number.isFinite(lineHeight) && lineHeight > 0 ? Math.max(1, Math.round(inner / lineHeight)) : tops.size;
  return { missing: false, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, lines,
    ellipsis: style.textOverflow === 'ellipsis' && style.overflowX !== 'visible',
    clamp: style.webkitLineClamp, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
    text: element.textContent };
}
const judgeText = (m) => {
  if (m.missing) return 'missing';
  if (m.lines > 1) return 'wrapped';
  if (m.scrollWidth > m.clientWidth + 1) return m.ellipsis ? 'ellipsized' : 'clipped';
  return 'fits';
};

/** 기본 Chromium 판이 설치돼 있지 않으면 설치된 가장 새 headless shell을 쓴다(Playwright 판과 브라우저 캐시 판이 어긋나는 노드가 있다). */
async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error?.message))) throw error;
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('node:os').homedir(), '.cache', 'ms-playwright');
    const shells = (await fs.readdir(cache)).filter((entry) => entry.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const shell of shells) {
      const executablePath = path.join(cache, shell, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      try { await fs.access(executablePath); } catch { continue; }
      metrics.browser = executablePath;
      return chromium.launch({ headless: true, executablePath });
    }
    throw error;
  }
}

async function openPage(browser, base, { width, height, mobile = true }, theme, query) {
  const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: true });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => metrics.errors.push({ query, message: error.message }));
  // cardChecks 진입은 서버 주소를 public-fixture.invalid 표식 주소로 두고 초상을 부른다. 그 요청은 막고(아래 route) 기록만 한다.
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource: net::ERR_FAILED/.test(msg.text())) metrics.errors.push({ query, message: msg.text() }); });
  await page.addInitScript(() => {
    // 계정 값이 검수 화면에 새지 않는다는 표식(capture-components와 같다).
    localStorage.setItem('soul-app-settings', JSON.stringify({ state: { serverUrl: 'https://must-not-read.invalid' }, version: 0 }));
    localStorage.setItem('soul-auth', JSON.stringify({ state: { jwt: 'public-sentinel' }, version: 0 }));
  });
  await page.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname === 'public-fixture.invalid') { metrics.blockedFixtureRequests = (metrics.blockedFixtureRequests ?? 0) + 1; await route.abort(); return; }
    if (target.origin !== base) { metrics.errors.push({ query, message: 'External request: ' + route.request().url() }); await route.abort(); return; }
    await route.continue();
  });
  const url = new URL(`${base}${prefix}index.html`);
  for (const [key, value] of Object.entries({ theme, ...query })) url.searchParams.set(key, value);
  await page.goto(url.toString());
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const noHorizontalOverflow = (page) => page.evaluate(() => ({
  document: document.documentElement.scrollWidth, window: window.innerWidth,
  body: document.body.scrollWidth,
}));

async function checkPostIts(browser, base, analysis, viewport, theme, view) {
  const { name, width } = viewport;
  const { context, page } = await openPage(browser, base, { ...viewport, height: POSTIT_PAGE_HEIGHT }, theme, { section: 'cardDependencies', view });
  await page.getByTestId('card-dependencies-review').waitFor();
  await page.waitForTimeout(400);
  const tag = `${name}-${theme}-${view}`;
  const entry = { name: tag, kind: 'postits', scenes: {} };
  metrics.viewports.push(entry);
  const overflow = await noHorizontalOverflow(page);
  check(overflow.document <= overflow.window, `${tag}: 문서 가로 넘침 ${JSON.stringify(overflow)}`);
  // 대비는 종이가 기울어진 채로는 화소가 섞이니 종이를 펴 놓고 잰다.
  await page.addStyleTag({ content: '[data-testid^="postit-card-"]{transform:none !important}' });
  const scenes = view === 'papers'
    ? COLORS.flatMap((color) => ['wait1', 'cancelled'].map((scene) => ({ key: `${scene}-${color}`, scene, color })))
    : Object.keys(POSTIT_SCENES).map((scene) => ({ key: scene, scene, color: 'yellow' }));
  for (const { key, scene, color } of scenes) {
    const expected = POSTIT_SCENES[scene];
    const cardId = `dep-card-${scene}-${color}`;
    const band = page.getByTestId(`postit-${cardId}-dependency`);
    const present = await band.count();
    const result = { present: present === 1 };
    entry.scenes[key] = result;
    const paper = await page.getByTestId(`postit-card-${cardId}`).boundingBox();
    check(paper && paper.x >= 0 && paper.x + paper.width <= width, `${tag}/${key}: 종이가 화면 폭 밖 ${JSON.stringify(paper)}`);
    if (expected.band === null) {
      check(present === 0, `${tag}/${key}: 선행 띠가 없어야 하는 장면에 띠가 있음`);
      if (scene === 'met') check(await page.getByTestId(`postit-${cardId}-ask-preview`).count() === 1, `${tag}/${key}: 선행이 충족된 카드는 볼 것 띠(ask)가 남아야 함`);
      continue;
    }
    if (!check(present === 1, `${tag}/${key}: 선행 띠 없음`)) continue;
    const measured = await page.evaluate(measureText, `postit-${cardId}-dependency`);
    const text = measured.text;
    result.text = text; result.judge = judgeText(measured);
    if (expected.band) check(text === expected.band, `${tag}/${key}: 띠 문구 ${JSON.stringify(text)} != ${JSON.stringify(expected.band)}`);
    if (expected.bandStart) check(text.startsWith(expected.bandStart), `${tag}/${key}: 띠 문구 시작 ${JSON.stringify(text.slice(0, 30))}`);
    check(measured.lines === 1, `${tag}/${key}: 띠가 한 줄이 아님(${measured.lines}줄)`);
    if (expected.ellipsis) check(result.judge === 'ellipsized', `${tag}/${key}: 긴 선행 제목이 말줄임으로 끊기지 않음 (${result.judge})`);
    else check(result.judge === 'fits', `${tag}/${key}: 띠 글자가 잘리거나 넘침 (${result.judge})`);
    const areaRect = await page.getByTestId(`postit-body-area-${cardId}`).boundingBox();
    const footerRect = await page.getByTestId(`postit-footer-${cardId}`).boundingBox();
    check(measured.left >= paper.x - 0.5 && measured.right <= paper.x + paper.width + 0.5, `${tag}/${key}: 띠가 종이 밖으로 나감`);
    check(measured.bottom <= areaRect.y + areaRect.height + 0.5, `${tag}/${key}: 띠 아래가 본문 영역에 잘림 (${measured.bottom} > ${areaRect.y + areaRect.height})`);
    check(measured.bottom <= footerRect.y + 0.5, `${tag}/${key}: 띠가 담당 줄과 겹침`);
    check(await page.getByTestId(`postit-body-${cardId}`).count() === 1, `${tag}/${key}: 요청 본문 자리가 사라짐`);
    check(await page.getByTestId(`postit-${cardId}-ask-preview`).count() === 0, `${tag}/${key}: 볼 것 띠가 선행 띠와 함께 보임`);
    // 화소로 잰 대비. 띠 요소 영역만 잘라 낸다.
    const contrast = await pixelContrast(analysis, await band.screenshot());
    result.contrast = contrast;
    check(contrast.ratio >= CONTRAST, `${tag}/${key}: 띠 글자 대비 ${contrast.ratio} < ${CONTRAST}`);
    const expectedTone = expected.tone;
    result.tone = expectedTone;
    const style = await band.evaluate((element) => { const s = getComputedStyle(element); return { color: s.color, background: s.backgroundColor }; });
    result.style = style;
    if (expectedTone === 'neutral') check(style.background === 'rgba(0, 0, 0, 0)', `${tag}/${key}: 중립 띠에 배경이 있음 ${style.background}`);
    else check(style.background !== 'rgba(0, 0, 0, 0)', `${tag}/${key}: 오류 띠에 옅은 배경이 없음`);
  }
  await page.screenshot({ path: path.join(output, `${tag}.png`) });
  await context.close();
}

async function checkDetailPhone(browser, base, viewport, theme, scene) {
  const { name, width, height } = viewport;
  const { context, page } = await openPage(browser, base, viewport, theme, { section: 'cardDependencies', view: 'detail', scene });
  const tag = `${name}-${theme}-detail-${scene}`;
  const entry = { name: tag, kind: 'detail', rows: {} };
  metrics.viewports.push(entry);
  await page.getByTestId('card-dependencies').waitFor();
  await page.waitForTimeout(400);
  await measureDetail(page, tag, entry, DETAIL_SCENES[scene], width, '선행 카드가 끝나기를 기다립니다');
  await page.screenshot({ path: path.join(output, `${tag}.png`) });
  if (scene === 'longest' && name === 'phone390' && theme === 'light') {
    // 창 크기 바꾸기: 열어 둔 채 가장 좁은 폭으로 줄여도 같은 단언이 선다.
    await page.setViewportSize({ width: 350, height: 760 });
    await page.waitForTimeout(400);
    const resized = { name: `${tag}→350`, kind: 'detail-resized', rows: {} };
    metrics.viewports.push(resized);
    await measureDetail(page, resized.name, resized, DETAIL_SCENES[scene], 350, '선행 카드가 끝나기를 기다립니다');
  }
  await context.close();
}

async function measureDetail(page, tag, entry, expected, width, nowText) {
  const overflow = await noHorizontalOverflow(page);
  check(overflow.document <= overflow.window && overflow.body <= overflow.window, `${tag}: 문서 가로 넘침 ${JSON.stringify(overflow)}`);
  const group = await page.getByTestId('card-dependencies').boundingBox();
  const header = await page.getByTestId('card-detail-header').boundingBox();
  check(group.x >= 0 && group.x + group.width <= width, `${tag}: 선행 묶음이 화면 폭 밖`);
  check(group.y >= header.y + header.height - 0.5, `${tag}: 선행 묶음이 머리 아래가 아님`);
  const now = page.getByTestId('card-detail-frame').getByText(nowText);
  if (await now.count()) {
    const nowBox = await now.first().boundingBox();
    check(nowBox.y >= group.y + group.height - 0.5, `${tag}: 선행 묶음이 상황판 위가 아님`);
  }
  entry.count = await page.getByTestId('card-dependencies-count').textContent();
  check(entry.count === expected.count, `${tag}: 충족/전체 ${entry.count} != ${expected.count}`);
  check((await page.getByRole('heading', { name: '선행 카드' }).count()) >= 1, `${tag}: 「선행 카드」 머리말 없음`);
  const borders = {};
  const rowIds = await page.locator('[data-testid^="card-dependency-surface-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid').replace('card-dependency-surface-', '')));
  let normalBorder = null;
  for (const id of rowIds) {
    const row = {};
    entry.rows[id] = row;
    const frame = await page.getByTestId(`card-dependency-${id}`).boundingBox();
    const surface = await page.getByTestId(`card-dependency-surface-${id}`).boundingBox();
    row.height = frame.height;
    check(frame.height >= MIN_HIT - 0.5, `${tag}/${id}: 행 누름 영역 높이 ${frame.height} < ${MIN_HIT}`);
    check(frame.x >= 0 && frame.x + frame.width <= width + 0.5, `${tag}/${id}: 행이 화면 폭 밖`);
    const inner = await page.getByTestId(`card-dependency-surface-${id}`).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    check(inner.scrollWidth <= inner.clientWidth + 1, `${tag}/${id}: 행 안쪽 가로 넘침 ${JSON.stringify(inner)}`);
    const title = await page.evaluate(measureText, `card-dependency-title-${id}`);
    const chip = await page.evaluate(measureText, `card-dependency-chip-${id}`);
    row.title = judgeText(title); row.chip = { judge: judgeText(chip), text: chip.text?.trim() };
    check(title.lines === 1, `${tag}/${id}: 제목이 한 줄이 아님`);
    const longTitle = expected.longTitle?.includes(id);
    if (longTitle) check(row.title === 'ellipsized', `${tag}/${id}: 긴 선행 제목이 말줄임으로 끊기지 않음 (${row.title})`);
    else check(row.title === 'fits' || row.title === 'ellipsized', `${tag}/${id}: 제목이 말줄임 없이 잘림 (${row.title})`);
    // 말줄임으로 줄어도 번호 옆에서 글자가 읽히는 폭은 남는다(번호 한 칸 폭 이상).
    check(title.width >= MIN_TITLE_WIDTH, `${tag}/${id}: 제목 폭 ${Math.round(title.width)} < ${MIN_TITLE_WIDTH}`);
    check(chip.right <= surface.x + surface.width + 0.5 && chip.left >= surface.x - 0.5, `${tag}/${id}: 칩이 행 밖으로 나감`);
    check(row.chip.judge === 'fits' && chip.lines === 1 && chip.width > 0, `${tag}/${id}: 칩이 잘리거나 접힘 (${row.chip.judge})`);
    check(title.right <= chip.left + 0.5, `${tag}/${id}: 제목과 칩이 겹침`);
    const label = expected.chips[id];
    if (label) check(row.chip.text.endsWith(label) , `${tag}/${id}: 칩 라벨 ${JSON.stringify(row.chip.text)} != ${label}`);
    const border = await page.getByTestId(`card-dependency-surface-${id}`).evaluate((el) => getComputedStyle(el).borderTopColor);
    borders[id] = border; row.border = border;
    const stopped = expected.stopped?.includes(id);
    row.stopped = !!stopped;
  }
  const stoppedIds = Object.keys(borders).filter((id) => expected.stopped?.includes(id));
  const plain = Object.keys(borders).filter((id) => !expected.stopped?.includes(id));
  if (plain.length) normalBorder = borders[plain[0]];
  for (const id of stoppedIds) check(normalBorder === null || borders[id] !== normalBorder, `${tag}/${id}: 멈춘 선행 행이 오류 테두리가 아님`);
  for (const id of plain) check(borders[id] === normalBorder, `${tag}/${id}: 정상 행 테두리가 서로 다름`);
  for (const id of Object.keys(expected.chips)) check(id in entry.rows, `${tag}/${id}: 기대한 선행 행이 없음`);
}

async function checkTablet(browser, base, theme) {
  const viewport = { name: 'tablet1210', width: 1210, height: 834, mobile: false };
  const { context, page } = await openPage(browser, base, viewport, theme, { section: 'cardChecks', safeArea: 'fixture', state: 'dependencies' });
  const tag = `${viewport.name}-${theme}-overlay`;
  const entry = { name: tag, kind: 'tablet-overlay', rows: {} };
  metrics.viewports.push(entry);
  await page.getByTestId('card-dependencies').waitFor();
  await page.waitForTimeout(500);
  const frame = await page.getByTestId('card-detail-frame').boundingBox();
  const group = await page.getByTestId('card-dependencies').boundingBox();
  check(group.x >= frame.x - 0.5 && group.x + group.width <= frame.x + frame.width + 0.5, `${tag}: 선행 묶음이 상세 틀 밖`);
  await measureDetail(page, tag, entry, TABLET_SCENE, viewport.width, '상황판 위에서 이번 작업의 현재 진행을 확인합니다.');
  await page.screenshot({ path: path.join(output, `${tag}.png`) });
  await context.close();
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  try {
    await selfTest(browser);
    const analysis = await browser.newPage();
    for (const theme of ['light', 'dark']) {
      for (const viewport of PHONES) {
        await checkPostIts(browser, base, analysis, viewport, theme, 'postits');
        if (viewport.name === 'phone390') await checkPostIts(browser, base, analysis, viewport, theme, 'papers');
        for (const scene of Object.keys(DETAIL_SCENES)) await checkDetailPhone(browser, base, viewport, theme, scene);
      }
      await checkTablet(browser, base, theme);
    }
    await analysis.close();
  } finally {
    await browser.close();
    server.close();
  }
  check(metrics.errors.length === 0, `페이지 오류나 외부 요청 ${JSON.stringify(metrics.errors.slice(0, 3))}`);
  check(metrics.apiRequests.every((request) => request.path === '/api/auth/status'), 'fixture 밖 API 요청이 있었음');
  metrics.passed = failures.length === 0;
  metrics.failures = failures;
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', 'utf8');
  if (failures.length) {
    console.error(`선행 카드 앱 화면 검사 실패 ${failures.length}건:\n` + failures.slice(0, 40).map((line) => ' - ' + line).join('\n'));
    process.exit(1);
  }
  console.log(`선행 카드 앱 화면 검사 통과: 화면 ${metrics.viewports.length}장, 측정 ${path.join(output, 'metrics.json')}`);
})().catch(async (error) => {
  console.error(error);
  metrics.failures = [...failures, String(error?.stack ?? error)];
  try { await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', 'utf8'); } catch { /* 출력 폴더가 없으면 건너뛴다 */ }
  process.exit(1);
});
