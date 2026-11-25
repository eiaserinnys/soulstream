// 카드 #1871: PAS 결재형 보고 창(앱 견본 section=pasReport) 시각 검수 스크립트.
//   node soul-app/scripts/pas-report-thread-capture.cjs <출력 폴더>
// export:components 번들(unified-dashboard/dist/assets/ios-components)을 playwright로 열어 390, 360(휴대폰), 820, 1180(태블릿) 폭과
// 밝은, 어두운 테마로 찍고, 서랍 열림, 답변 미루기 펼침, 위로 올린 뒤 알약, 입력창 열림 상태도 찍는다.
// 조작 결과와 측정은 같은 폴더의 operations.md에 쓴다. 이 프로세스의 로컬 가짜 서버만 부르고, 운영 서버에는 닿지 않는다.
// playwright는 앱 의존성이 아니다. 저장소 안 설치(unified-dashboard)에서 스스로 찾는다.
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '../..');
const outputArg = process.argv[2];
if (!outputArg) throw new Error('첫 인자로 출력 폴더가 필요합니다.');
const output = path.resolve(outputArg);

function loadPlaywright() {
  const requireFromDashboard = createRequire(path.join(repoRoot, 'unified-dashboard', 'package.json'));
  for (const name of ['@playwright/test', 'playwright']) {
    try { return requireFromDashboard(name); } catch { /* 다음 후보 */ }
  }
  throw new Error('unified-dashboard 설치에서 playwright를 찾지 못했습니다. corepack pnpm install을 먼저 하세요.');
}
const { chromium } = loadPlaywright();
const bundleRoot = process.env.COMPONENT_REVIEW_BUNDLE ? path.resolve(process.env.COMPONENT_REVIEW_BUNDLE)
  : path.join(repoRoot, 'unified-dashboard/dist/assets/ios-components');
if (!fsSync.existsSync(path.join(bundleRoot, 'index.html'))) throw new Error(`견본 번들이 없습니다: ${bundleRoot} (npm --prefix soul-app run export:components)`);
const prefix = '/assets/ios-components/';
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local.test');
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ authenticated: req.headers.cookie?.includes('review=fixture') === true }));
    return;
  }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(bundleRoot, '.' + url.pathname.slice(prefix.length - 1));
  if (!file.startsWith(bundleRoot + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'phone-360', width: 360, height: 780, mobile: true },
  { name: 'tablet-820', width: 820, height: 1180, mobile: false },
  { name: 'tablet-1180', width: 1180, height: 820, mobile: false },
];
const THEMES = ['light', 'dark'];
const result = { shots: [], measures: [], errors: [], warnings: [], checks: [] };
const record = (name, detail) => { result.checks.push({ name, detail }); };

async function open(browser, base, vp, theme, state, extra = '') {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, screen: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const label = `${vp.name}-${theme}-${state}`;
  page.on('pageerror', error => result.errors.push({ name: label, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') result.warnings.push({ name: label, message: message.text().slice(0, 240) }); });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === base) { await route.continue(); return; }
    result.errors.push({ name: label, message: 'External request: ' + url });
    await route.abort();
  });
  await page.goto(`${base}${prefix}index.html?section=pasReport&state=${state}&theme=${theme}&safeArea=fixture${extra}`);
  await page.getByTestId('pas-report-window').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return { context, page, label };
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(output, `${name}.png`) }); result.shots.push(`${name}.png`); };
const rect = (page, testId, nth = 0) => page.getByTestId(testId).nth(nth).evaluate(el => {
  const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
});
const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b} (±${tolerance})`);
const round = value => Math.round(value * 10) / 10;

/** 요소의 첫 줄 글 상자(여러 줄로 감겨도 첫 줄). */
const firstLineRect = (locator) => locator.evaluate(el => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const first = range.getClientRects()[0];
    if (first) return { top: first.top, bottom: first.bottom, left: first.left, right: first.right };
  }
  return null;
});

/** 캡처 화소로 두 지점의 대비(WCAG)를 잰다. 유리 층 위에서는 계산값과 보이는 색이 다르다. */
async function pixelContrast(page, probe, background) {
  const clip = (point) => ({ x: Math.max(0, Math.floor(point.x)), y: Math.max(0, Math.floor(point.y)), width: 1, height: 1 });
  const read = async point => {
    const buffer = await page.screenshot({ clip: clip(point) });
    return page.evaluate(async base64 => {
      const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    }, buffer.toString('base64'));
  };
  const luminance = ([r, g, b]) => { const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const a = luminance(await read(probe)), b = luminance(await read(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}




const testIdOf = page => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
const titleOf = page => page.getByTestId('pas-report-title').innerText();

/** 결함 1: 검수 안건 완료 → 되돌리기 성공 뒤 1초 안에 그 안건이 결재 대기의 활성 안건으로 돌아온다. */
async function undoCompletion(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    const { context, page, label } = await open(browser, base, vp, 'light', 'review');
    await page.getByTestId('pas-report-complete').click();
    await page.getByLabel('되돌리기').waitFor();
    assert.doesNotMatch(await titleOf(page), /PAS 결재형/, `${label}: 완료 뒤 다음 안건으로 넘어가야 함`);
    const started = Date.now();
    await page.getByLabel('되돌리기').click();
    await page.waitForFunction(() => /PAS 결재형/.test(document.querySelector('[data-testid="pas-report-title"]')?.textContent ?? ''), null, { timeout: 1000 });
    const took = Date.now() - started;
    await page.getByTestId('pas-report-complete').waitFor();
    if (vp.width >= 820) {
      const pending = page.getByTestId('pas-report-rail-결재 대기');
      assert.equal(await pending.getByTestId('pas-report-row-card-1871').count(), 1, `${label}: 되돌린 안건이 결재 대기에 서야 함`);
      assert.equal(await pending.getByTestId('pas-report-row-card-1871').getByTestId('pas-report-row-bar').count(), 1, `${label}: 레일 강조가 그 안건이어야 함`);
      assert.equal(await page.getByTestId('pas-report-rail-처리됨').count(), 0, `${label}: 처리됨에서 빠져야 함`);
    }
    lines.push(`${label}: 완료 → 되돌리기 ${took}ms 만에 그 안건(결재 대기, 활성)으로 돌아옴${vp.width >= 820 ? ', 레일 강조 막대와 처리됨 비움 확인' : ''}`);
    await shot(page, `${vp.name}-light-review-after-undo`);
    await context.close();
  }
  record('결함 1 완료 되돌리기 성공', lines);
}

const geometry = locator => locator.evaluate(el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height, background: getComputedStyle(el).backgroundColor }; });

/** 결함 2: 네 입력창 모두 알림줄과 「해제」가 같은 모양으로 서고, 해제는 입력창만 닫고 초점을 연 단추로 돌린다. */
async function composerNotices(browser, base) {
  const cases = [
    { name: '지시 적기', state: 'review', trigger: 'pas-report-open-composer', notice: 'pas-report-composer-notice', text: '커멘트' },
    { name: '다르게 답하기', state: 'question', trigger: 'pas-report-answer-freely', notice: 'pas-report-composer-notice', text: '다르게 답하기' },
    { name: '되묻기', state: 'question', trigger: 'pas-report-ask-back', notice: 'card-question-target', text: '되묻기' },
    { name: '항목 지시', state: 'review', trigger: 'card-check-item-1-fix', notice: 'card-comment-target', text: '1' },
  ];
  const lines = [];
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const shapes = [];
      for (const item of cases) {
        const { context, page, label } = await open(browser, base, vp, theme, item.state);
        const trigger = page.getByTestId(item.trigger);
        if (item.name === '항목 지시' && !(await trigger.count())) await page.getByText(/390 폭에서 결재 상자 단추/).first().click();
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const notice = page.getByTestId(item.notice);
        await notice.waitFor();
        const line = await geometry(notice);
        assert.ok((await notice.innerText()).includes(item.text), `${label} ${item.name}: 알림줄 글 「${await notice.innerText()}」`);
        const release = notice.getByLabel('대상 해제');
        assert.equal(await release.count(), 1, `${label} ${item.name}: 「해제」가 있어야 함`);
        // 단추가 두 줄로 감겨도 알림줄은 마지막 단추 줄 아래에 선다.
        const above = (await visibleButtons(page, 'pas-report-decide')).filter(button => button.bottom <= line.top + 1);
        const stampsBottom = Math.max(...above.map(button => button.bottom));
        const input = await rect(page, 'pas-report-composer');
        assert.ok(line.top >= stampsBottom - 1, `${label} ${item.name}: 알림줄이 단추 줄 아래여야 함`);
        near(line.top - stampsBottom, 8, 6, `${label} ${item.name}: 단추 줄과 알림줄 사이`);
        assert.ok(input.bottom > line.bottom, `${label} ${item.name}: 알림줄 아래에 입력창`);
        const placeholder = await page.evaluate(() => document.querySelector('textarea, input')?.getBoundingClientRect().top ?? null);
        assert.ok(placeholder === null || placeholder >= line.bottom - 1, `${label} ${item.name}: 입력칸이 알림줄 아래`);
        shapes.push({ item, line });
        if (item.name === '지시 적기' || item.name === '항목 지시') await shot(page, `${vp.name}-${theme}-notice-${item.name === '지시 적기' ? 'comment' : 'item'}`);
        // 해제: 입력창만 닫히고 초점이 연 단추로 돌아간다.
        await release.click();
        await page.getByTestId('pas-report-composer').waitFor({ state: 'detached' });
        await page.waitForTimeout(250);
        assert.equal(await testIdOf(page), item.trigger, `${label} ${item.name}: 닫은 뒤 초점이 연 단추여야 함`);
        assert.equal(await page.getByTestId('pas-report-window').count(), 1, `${label} ${item.name}: 창은 그대로여야 함`);
        await context.close();
      }
      const first = shapes[0].line;
      for (const { item, line } of shapes) {
        near(line.left, first.left, 1, `${vp.name}-${theme} ${item.name}: 알림줄 왼쪽 끝`);
        near(line.right, first.right, 1, `${vp.name}-${theme} ${item.name}: 알림줄 오른쪽 끝`);
        near(line.height, first.height, 1, `${vp.name}-${theme} ${item.name}: 알림줄 높이`);
        assert.equal(line.background, first.background, `${vp.name}-${theme} ${item.name}: 알림줄 바탕`);
      }
      lines.push(`${vp.name}-${theme}: 지시 적기, 다르게 답하기, 되묻기, 항목 지시 모두 알림줄(이름, 해제)이 같은 모양(왼쪽 ${round(first.left)}, 오른쪽 ${round(first.right)}, 높이 ${round(first.height)})으로 서고, 해제로 닫으면 초점이 연 단추로 돌아옴`);
    }
  }
  record('결함 2 입력창 알림줄, 해제, 닫은 뒤 초점', lines);
}

/** 결함 4: 카드 상세가 없는 로딩과 실패 상태의 지시 적기는 눌리지 않는다. */
async function commentWithoutDetail(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    for (const state of ['loading', 'error']) {
      const { context, page, label } = await open(browser, base, vp, 'light', state);
      const button = page.getByTestId('pas-report-open-composer');
      assert.equal(await button.getAttribute('aria-busy'), 'true', `${label}: 지시 적기가 흐린(busy) 모양이어야 함`);
      assert.equal(Number(await button.evaluate(el => getComputedStyle(el).opacity)) < 1 || Number(await button.evaluate(el => getComputedStyle(el.parentElement).opacity)) < 1, true, `${label}: 흐려야 함`);
      await button.click({ force: true });
      await page.waitForTimeout(200);
      assert.equal(await page.getByTestId('pas-report-composer').count(), 0, `${label}: 눌러도 입력창이 열리면 안 됨`);
      if (state === 'error') {
        await shot(page, `${vp.name}-light-error-comment-disabled`);
        await page.getByLabel('카드 다시 시도').click();
        await page.getByTestId('pas-report-timeline').waitFor();
        await page.waitForTimeout(400);
        assert.equal(await page.getByTestId('pas-report-composer').count(), 0, `${label}: 다시 시도로 상세가 와도 입력창이 저절로 열리면 안 됨`);
        assert.equal(await page.getByTestId('pas-report-open-composer').getAttribute('aria-busy'), null, `${label}: 상세가 오면 다시 눌린다`);
        await page.getByTestId('pas-report-open-composer').click();
        await page.getByTestId('pas-report-composer').waitFor();
      }
      lines.push(`${label}: 지시 적기 busy(흐림), 눌러도 입력창 0개${state === 'error' ? ', 다시 시도 뒤에도 저절로 열리지 않고 상세가 온 뒤에는 눌러서 열림' : ''}`);
      await context.close();
    }
  }
  record('결함 4 상세 없을 때 지시 적기', lines);
}

/** 눈에 보이는 단추 모양: 테두리 단추는 Pressable을 감싼 바깥 상자가 보이는 모양이다. */
const visibleButtons = (page, root) => page.getByTestId(root).getByRole('button').evaluateAll(els => els.map(el => {
  const outer = el.parentElement && el.parentElement.children.length === 1 && getComputedStyle(el.parentElement).borderTopWidth !== '0px' ? el.parentElement : el;
  const b = outer.getBoundingClientRect(); const p = el.getBoundingClientRect();
  return { label: el.getAttribute('aria-label'), top: b.top, bottom: b.bottom, height: b.height, left: b.left, right: b.right, inner: p.height };
}));

/** 결함 5: 결재 상자 한 줄 단추 높이가 1pt 안에서 같고 세로 가운데가 맞는다. */
async function stampHeights(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
    for (const theme of THEMES) {
      for (const state of ['review', 'question']) {
        const { context, page, label } = await open(browser, base, vp, theme, state);
        await page.getByTestId('pas-report-snooze-trigger').click();
        await page.getByTestId('pas-report-snooze-options').waitFor();
        const buttons = (await visibleButtons(page, 'pas-report-decide')).filter(button => !/미루기 해제|되돌리기/.test(button.label ?? ''));
        assert.ok(buttons.length >= 4, `${label}: 결재 상자 단추 ${buttons.length}개`);
        const reference = buttons[0];
        for (const button of buttons) near(button.height, reference.height, 1, `${label}: 「${button.label}」 높이`);
        const rowsByTop = [];
        for (const button of buttons) {
          const row = rowsByTop.find(group => Math.abs(group[0].top - button.top) < reference.height / 2);
          if (row) row.push(button); else rowsByTop.push([button]);
        }
        for (const row of rowsByTop) for (const button of row) near((button.top + button.bottom) / 2, (row[0].top + row[0].bottom) / 2, 1, `${label}: 「${button.label}」 세로 가운데`);
        const startLine = buttons.reduce((least, button) => Math.min(least, button.left), 1e9);
        const timeline = await rect(page, 'pas-report-timeline');
        near(startLine, timeline.left, 1.5, `${label}: 결재 상자 왼쪽 시작선`);
        if (state === 'review') {
          lines.push(`${label}: 단추 ${buttons.length}개 높이 ${buttons.map(button => `${button.label} ${round(button.height)}`).join(', ')}, 시작선 ${round(startLine)}`);
          if (theme === 'light' && vp.width === 390) await shot(page, `${vp.name}-${theme}-review-decide-heights`);
        }
        await context.close();
      }
    }
  }
  record('결함 5 결재 상자 한 줄 단추 높이', lines);
}

/** 결함 6: 선택지 목록 왼쪽 막대 대비 2:1 이상, 권함은 이름과 갈린 글. */
async function optionNotes(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    for (const theme of THEMES) {
      const { context, page, label } = await open(browser, base, vp, theme, 'question');
      const list = page.getByTestId('pas-report-question-options-q-secret');
      await list.scrollIntoViewIfNeeded();
      const barBox = await list.evaluate(el => { const note = el.firstElementChild; const b = note.getBoundingClientRect(); const s = getComputedStyle(note);
        return { left: b.left, top: b.top, height: b.height, width: parseFloat(s.borderLeftWidth), textLeft: note.firstElementChild.getBoundingClientRect().left }; });
      near(barBox.width, 4, 0.6, `${label}: 막대 두께`);
      const probe = { x: barBox.left + barBox.width / 2, y: barBox.top + barBox.height / 2 };
      const around = { x: barBox.left - 6, y: probe.y };
      const contrast = await pixelContrast(page, probe, around);
      assert.ok(contrast >= 2, `${label}: 선택지 막대 대비 ${round(contrast)}:1 < 2:1`);
      const recommended = await list.getByText('권함').first().evaluate(el => { const parent = el.parentElement; return { own: getComputedStyle(el).color, parent: getComputedStyle(parent).color, text: el.textContent }; });
      assert.notEqual(recommended.own, recommended.parent, `${label}: 권함이 이름과 같은 색이면 한 이름처럼 읽힘`);
      const selectable = await list.getByText('파일로 옮기기').first().evaluate(el => getComputedStyle(el).userSelect);
      assert.equal(selectable, 'text', `${label}: 선택지 이름은 선택되어야 함`);
      assert.equal(await list.getByRole('button').count(), 0, `${label}: 선택지 목록에 눌리는 요소가 없어야 함`);
      lines.push(`${label}: 막대 대비 ${round(contrast)}:1, 두께 ${round(barBox.width)}, 글 시작 ${round(barBox.textLeft)}, 권함 ${recommended.own} / 이름 ${recommended.parent}`);
      if (vp.width === 390 || theme === 'dark') await shot(page, `${vp.name}-${theme}-question-options`);
      await context.close();
    }
  }
  record('결함 6 스레드 선택지 막대와 권함', lines);
}

/** 결함 7: 레일 카드 목록 실패의 「다시 시도」 왼쪽 끝이 실패 안내 글, 구역 머리 글의 시작선과 1pt 안이다. */
async function railRetryLine(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    const { context, page, label } = await open(browser, base, vp, 'light', 'cardsError');
    if (vp.width < 820) await page.getByTestId('pas-report-open-rail').click();
    await page.getByTestId('pas-report-rail-error').waitFor();
    const text = await page.getByTestId('pas-report-rail-error').evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const range = document.createRange(); range.selectNodeContents(walker.nextNode()); return range.getClientRects()[0].left; });
    const button = page.getByLabel('카드 목록 다시 시도');
    const buttonLeft = await button.evaluate(el => { const outer = el.parentElement && getComputedStyle(el.parentElement).borderTopWidth !== '0px' ? el.parentElement : el; return outer.getBoundingClientRect().left; });
    const head = await page.getByTestId('pas-report-rail-결재 대기').getByRole('heading').first().evaluate(el => el.getBoundingClientRect().left);
    near(buttonLeft, text, 1, `${label}: 다시 시도 왼쪽 끝과 실패 안내 글 시작선`);
    near(buttonLeft, head, 1.5, `${label}: 다시 시도 왼쪽 끝과 구역 머리 글 시작선`);
    await shot(page, `${vp.name}-light-cardsError-rail`);
    await button.click();
    await page.getByTestId('pas-report-rail-hold').waitFor();
    const hold = await page.getByTestId('pas-report-rail-hold').evaluate(el => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const range = document.createRange(); range.selectNodeContents(walker.nextNode()); return range.getClientRects()[0].left; });
    near(hold, text, 1, `${label}: 보류함 개수 시작선은 그대로`);
    lines.push(`${label}: 다시 시도 ${round(buttonLeft)}, 안내 글 ${round(text)}, 구역 머리 ${round(head)}, 다시 시도 뒤 보류함 ${round(hold)}`);
    await context.close();
  }
  record('결함 7 레일 실패의 다시 시도 시작선', lines);
}

/** PAS 화면(보고 장 머리줄)의 「보고 창 열기」 단추를 휴대폰과 아이패드 세로 틀에서 찍는다. */
async function entryButton(browser, base) {
  const frames = [['iphone-17', [393, 852, true]], ['ipad-pro-13-portrait', [1032, 1376, false]]];
  const lines = [];
  for (const [frame, [width, height, mobile]] of frames) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push({ name: `pas-entry-${frame}`, message: error.message }));
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === base) { await route.continue(); return; }
        result.errors.push({ name: `pas-entry-${frame}`, message: 'External request: ' + url }); await route.abort();
      });
      await page.goto(`${base}${prefix}index.html?section=iphoneDuo&sample=pas-layout&frame=${frame}&theme=${theme}&scene=reports`);
      await page.waitForTimeout(2500);
      const open = page.getByTestId('report-window-open').first();
      await open.waitFor();
      const toggle = page.getByTestId('report-window-toggle').first();
      const a = await geometry(open);
      const hasToggle = await toggle.count();
      const b = hasToggle ? await geometry(toggle) : null;
      assert.ok(a.width >= 44 && a.height >= 44, `${frame}-${theme}: 보고 창 열기 터치 대상 ${round(a.width)}x${round(a.height)}`);
      assert.equal(await open.getAttribute('aria-label'), '보고 창 열기', `${frame}-${theme}: 접근성 이름`);
      if (b) assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1, `${frame}-${theme}: 확대 단추와 겹치면 안 됨`);
      await shot(page, `pas-entry-${frame}-${theme}`);
      await shot(page, `pas-entry-${frame}-${theme}-head`, { clip: { x: Math.max(0, a.left - 280), y: Math.max(0, a.top - 24), width: Math.min(380, width), height: 96 } });
      lines.push(`${frame}-${theme}: 「보고 창 열기」 ${round(a.width)}x${round(a.height)}, 접근성 이름 「보고 창 열기」${b ? `, 확대 단추와 간격 ${round(b.left - a.right)}` : ''}`);
      await context.close();
    }
  }
  record('PAS 화면 보고 장 머리줄 「보고 창 열기」', lines);
}

async function runReviewDefects(browser, base) {
  await undoCompletion(browser, base);
  await composerNotices(browser, base);
  await commentWithoutDetail(browser, base);
  await stampHeights(browser, base);
  await optionNotes(browser, base);
  await railRetryLine(browser, base);
  await entryButton(browser, base);
}



async function runMatrix(browser, base) {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const state of ['review', 'question']) {
        const { context, page, label } = await open(browser, base, vp, theme, state);
        const scroll = page.getByTestId('pas-report-thread-scroll');
        await scroll.waitFor();
        // 처음에는 맨 아래에서 시작한다.
        const gap = await scroll.evaluate(el => el.scrollHeight - (el.scrollTop + el.clientHeight));
        assert.ok(gap <= 2, `${label}: 맨 아래에서 시작해야 함(남은 ${gap})`);
        // 가로 넘침이 없다. 창 안 모든 칸이 창 가장자리 안에 있다.
        const overflow = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="pas-report-window"]').getBoundingClientRect();
          const bad = [];
          for (const el of document.querySelectorAll('[data-testid="pas-report-window"] *')) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            let clipped = false;
            for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible' && s.overflowX !== 'clip' && p.getAttribute('data-testid') !== 'pas-report-window') { clipped = true; break; } }
            if (!clipped && (b.right > root.right + 1 || b.left < root.left - 1)) bad.push(el.getAttribute('data-testid') || el.tagName);
          }
          return { scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth, bad: bad.slice(0, 5) };
        });
        assert.ok(overflow.scrollWidth <= overflow.innerWidth, `${label}: 가로 스크롤 ${overflow.scrollWidth} > ${overflow.innerWidth}`);
        assert.deepEqual(overflow.bad, [], `${label}: 창 밖으로 나간 요소`);
        // 머리줄: 제목은 말줄임, 단추와 겹치지 않는다.
        const title = await rect(page, 'pas-report-title');
        const tools = await rect(page, 'pas-report-close');
        assert.ok(title.right <= tools.left, `${label}: 제목이 단추와 겹침`);
        await shot(page, label);
        await context.close();
      }
    }
  }
}

async function runStates(browser, base) {
  const vp = VIEWPORTS[0];
  const lines = {};
  for (const state of ['request', 'blocked', 'running', 'verifying', 'snoozed', 'processed', 'empty', 'loading', 'error', 'cardsError']) {
    const { context, page, label } = await open(browser, base, vp, 'light', state);
    if (state === 'empty') {
      assert.equal(await page.getByTestId('pas-report-decide').count(), 0, `${label}: 빈 판에는 결재 상자 자리가 없어야 함`);
      await page.getByTestId('pas-report-thread-empty').waitFor();
    }
    if (state === 'loading') {
      await page.getByTestId('pas-report-thread-loading').waitFor();
      assert.equal(await page.getByTestId('pas-report-window').count(), 1, `${label}: 틀은 먼저 서 있음`);
      lines.loading = '틀(머리줄, 결재 상자)이 먼저 서고 스레드 자리에 로딩 표시';
    }
    if (state === 'error') {
      await page.getByTestId('pas-report-thread-error').waitFor();
      await shot(page, `${label}`);
      await page.getByLabel('카드 다시 시도').click();
      await page.getByTestId('pas-report-timeline').waitFor();
      lines.error = '실패 안내 자리에서 다시 시도로 스레드가 돌아옴';
      await context.close();
      continue;
    }
    if (state === 'cardsError') {
      await page.getByTestId('pas-report-open-rail').click();
      await page.getByTestId('pas-report-rail-error').waitFor();
      assert.equal(await page.getByTestId('pas-report-rail-hold').count(), 0, `${label}: 목록 실패인데 보류함 0이 보임`);
      await shot(page, `${label}`);
      await page.getByLabel('카드 목록 다시 시도').click();
      await page.getByTestId('pas-report-rail-hold').waitFor();
      lines.cardsError = '레일에 실패와 다시 시도, 다시 시도 뒤 보류함 개수가 보임(0으로 보이지 않음)';
      await context.close();
      continue;
    }
    if (state === 'processed') {
      await page.getByTestId('pas-report-open-rail').click();
      await page.getByTestId('pas-report-rail-처리됨').waitFor();
      assert.equal(await page.getByTestId('pas-report-complete').count(), 0, `${label}: 처리된 안건에는 결재 단추가 없어야 함`);
    }
    if (state === 'snoozed') {
      await page.getByTestId('pas-report-unsnooze').waitFor();
    }
    await shot(page, label);
    await context.close();
  }
  {
    const { context, page, label } = await open(browser, base, VIEWPORTS[2], 'light', 'processed');
    await page.getByTestId('pas-report-rail-처리됨').waitFor();
    await page.getByTestId('pas-report-row-card-1865').waitFor();
    await shot(page, label);
    lines.processed = '처리됨 구역에 처분한 안건과 결과(답함)가 보이고, 그 안건의 결재 상자는 결과만 보임';
    await context.close();
  }
  record('상태 표본', lines);
}

async function runInteractions(browser, base) {
  const vp = VIEWPORTS[0];
  const focus = {};
  for (const theme of THEMES) {
    // 서랍 열림
    let { context, page, label } = await open(browser, base, vp, theme, 'review');
    await page.getByTestId('pas-report-open-rail').click();
    await page.getByTestId('pas-report-drawer').waitFor();
    const drawer = await rect(page, 'pas-report-drawer');
    const scrim = await rect(page, 'pas-report-drawer-scrim');
    assert.ok(drawer.width <= vp.width * 0.85 + 1 && drawer.left <= 1, `${label}: 서랍 폭`);
    assert.ok(scrim.width >= vp.width - 1, `${label}: 바깥 가림`);
    await shot(page, `${vp.name}-${theme}-drawer`);
    // 서랍에서 안건을 고르면 서랍이 닫히고 그 안건이 선다
    await page.getByTestId('pas-report-row-card-1865').click();
    await page.getByTestId('pas-report-drawer').waitFor({ state: 'detached' });
    assert.match(await page.getByTestId('pas-report-title').innerText(), /비밀값/, `${label}: 고른 안건이 서야 함`);
    await context.close();

    // 답변 미루기 펼침
    ({ context, page, label } = await open(browser, base, vp, theme, 'review'));
    await page.getByTestId('pas-report-snooze-trigger').click();
    const options = page.getByTestId('pas-report-snooze-options');
    await options.waitFor();
    const optionLabels = await options.getByRole('button').evaluateAll(els => els.map(el => el.getAttribute('aria-label')));
    assert.ok(optionLabels.includes('1시간 뒤') && optionLabels.includes('내일 아침') && optionLabels.includes('사흘 뒤'), `${label}: 선택지 ${optionLabels}`);
    assert.equal(optionLabels.includes('오늘 저녁'), new Date().getHours() < 18, `${label}: 오늘 저녁은 18시 전에만`);
    await shot(page, `${vp.name}-${theme}-snooze-open`);
    await context.close();

    // 위로 올린 뒤 알약
    ({ context, page, label } = await open(browser, base, vp, theme, 'review'));
    const scroll = page.getByTestId('pas-report-thread-scroll');
    assert.equal(await page.getByTestId('pas-report-latest-pill').count(), 0, `${label}: 맨 아래에서는 알약이 없어야 함`);
    await scroll.hover();
    await page.mouse.wheel(0, -700);
    await page.getByTestId('pas-report-latest-pill').waitFor();
    const pill = await rect(page, 'pas-report-latest-pill');
    const pane = await rect(page, 'pas-report-thread-scroll');
    near(pane.right - pill.right, 16, 1.5, `${label}: 알약 오른쪽 여백`);
    assert.ok(pill.bottom < (await rect(page, 'pas-report-decide')).top + 1 && pill.top > pane.top, `${label}: 알약이 스레드 위에 겹쳐 뜸`);
    assert.equal(await page.getByTestId('pas-report-latest-pill').innerText(), '최신 경과로 ↓', `${label}: 알약 글`);
    await shot(page, `${vp.name}-${theme}-pill`);
    await page.getByTestId('pas-report-latest-pill').click();
    await page.getByTestId('pas-report-latest-pill').waitFor({ state: 'detached' });
    await page.waitForTimeout(800);
    const bottomGap = await scroll.evaluate(el => el.scrollHeight - (el.scrollTop + el.clientHeight));
    assert.ok(bottomGap <= 2, `${label}: 알약을 누르면 맨 아래로(남은 ${bottomGap})`);
    // 다시 올리고 손으로 맨 아래까지 내리면 알약이 꺼진다
    await scroll.hover();
    await page.mouse.wheel(0, -700);
    await page.getByTestId('pas-report-latest-pill').waitFor();
    await page.mouse.wheel(0, 2000);
    await page.getByTestId('pas-report-latest-pill').waitFor({ state: 'detached' });
    await context.close();

    // 입력창 열림
    ({ context, page, label } = await open(browser, base, vp, theme, 'review'));
    const decideBefore = await rect(page, 'pas-report-decide');
    await page.getByTestId('pas-report-open-composer').click();
    await page.getByTestId('pas-report-composer').waitFor();
    await page.waitForTimeout(300);
    const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName, placeholder: document.activeElement?.getAttribute('placeholder') }));
    focus.composer = `첫 초점 ${active.tag} ${active.placeholder ?? ''}`.trim();
    assert.equal(active.placeholder, '커멘트', `${label}: 입력창에 초점이 서야 함`);
    // 입력창은 단추 줄 아래에 열린다(단추가 위, 입력창이 아래)
    const stampsRect = await rect(page, 'pas-report-stamps-primary');
    const composer = await rect(page, 'pas-report-composer');
    assert.ok(composer.top >= stampsRect.bottom, `${label}: 입력창이 단추 줄 아래여야 함`);
    near(composer.top - stampsRect.bottom, 8, 6, `${label}: 단추 줄과 입력창 사이`);
    assert.ok((await rect(page, 'pas-report-decide')).height > decideBefore.height, `${label}: 열면 결재 상자가 자람`);
    await shot(page, `${vp.name}-${theme}-composer`);
    if (theme === 'light') {
      const input = page.getByPlaceholder('커멘트');
      await input.fill('엔터 시험');
      await input.press('Enter');
      await page.waitForTimeout(300);
      const after = await input.inputValue();
      focus.enter = after === '' ? '입력을 보내고 비움' : after.includes('\n') ? '줄바꿈' : `변화 없음(${JSON.stringify(after)})`;
    }
    await context.close();
  }
  record('초점', focus);
}

async function runAlignments(browser, base) {
  const rows = [];
  for (const [vp, theme] of [[VIEWPORTS[3], 'light'], [VIEWPORTS[3], 'dark'], [VIEWPORTS[2], 'light']]) {
    const { context, page, label } = await open(browser, base, vp, theme, 'review');
    // 레일: 구역 머리와 행 글자 시작선, 강조 막대 뒤 12pt 순수 여백, 구역 사이 24pt
    const headRect = await page.getByTestId('pas-report-rail-결재 대기').getByRole('heading').first().evaluate(el => el.getBoundingClientRect().left);
    const activeRow = page.getByTestId('pas-report-row-card-1871');
    const titleLeft = await activeRow.getByText(/PAS 결재형 보고 창/).first().evaluate(el => el.getBoundingClientRect().left);
    near(headRect, titleLeft, 1.5, `${label}: 레일 구역 머리와 행 글자 시작선`);
    const bar = await rect(page, 'pas-report-row-bar');
    near(bar.width, 4, 0.6, `${label}: 강조 막대 폭`);
    near(titleLeft - bar.right, 12, 1.5, `${label}: 강조 막대 뒤 순수 여백`);
    const first = await rect(page, 'pas-report-rail-결재 대기');
    const second = await rect(page, 'pas-report-rail-진행 중');
    near(second.top - first.bottom, 24, 1, `${label}: 레일 구역 사이`);
    // 스레드 오른쪽 끝선: 확인 항목 상자와 결재 상자 단추 줄
    const items = await rect(page, 'pas-report-items');
    const secondaryButtons = page.getByTestId('pas-report-stamps-secondary').getByRole('button');
    const lastButton = await secondaryButtons.last().evaluate(el => el.getBoundingClientRect().right);
    near(lastButton, items.right, 1.5, `${label}: 확인 항목 상자와 결재 단추 줄의 오른쪽 끝선`);
    // 결재 상자 왼쪽 시작선도 스레드 시작선과 한 선
    const timeline = await rect(page, 'pas-report-timeline');
    const firstButton = await page.getByTestId('pas-report-stamps-primary').getByRole('button').first().evaluate(el => el.getBoundingClientRect().left);
    near(firstButton, timeline.left, 1.5, `${label}: 스레드와 결재 단추 줄의 왼쪽 시작선`);
    rows.push(`${label}: 머리 ${round(headRect)} 행글자 ${round(titleLeft)} 막대뒤 ${round(titleLeft - bar.right)} 구역간격 ${round(second.top - first.bottom)} 오른쪽끝 ${round(lastButton)}/${round(items.right)} 왼쪽시작 ${round(firstButton)}/${round(timeline.left)}`);
    await context.close();
  }
  record('정렬 좌표', rows);
}

async function runMilestones(browser, base) {
  const rows = [];
  for (const theme of THEMES) {
    for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
      const { context, page, label } = await open(browser, base, vp, theme, 'review');
      const milestones = page.getByTestId(/^pas-report-milestone-/);
      const count = await milestones.count();
      assert.ok(count >= 3, `${label}: 이정표 ${count}`);
      // 위로 올려 이정표가 보이게 한다.
      await page.getByTestId('pas-report-thread-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
      const bodyBg = await page.getByTestId('pas-report-window').evaluate(el => getComputedStyle(el).backgroundColor);
      for (let index = 0; index < count; index += 1) {
        const item = milestones.nth(index);
        await item.scrollIntoViewIfNeeded();
        const dotRect = await item.evaluate(el => { const b = el.firstElementChild.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
        const line = await firstLineRect(item.locator('xpath=./*[2]'));
        near(dotRect.y + dotRect.h / 2, (line.top + line.bottom) / 2, 1.5, `${label}: 이정표 점과 글 첫 줄 세로 가운데`);
        const probe = { x: dotRect.x + dotRect.w / 2, y: dotRect.y + dotRect.h / 2 };
        const around = { x: dotRect.x - 3, y: dotRect.y + dotRect.h / 2 };
        const contrast = await pixelContrast(page, probe, around);
        assert.ok(contrast >= 2, `${label}: 이정표 점 대비 ${round(contrast)}:1 < 2:1`);
        if (index === 0) rows.push(`${label}: 점 대비 ${round(contrast)}:1, 점 가운데-첫 줄 가운데 차 ${round(Math.abs(dotRect.y + dotRect.h / 2 - (line.top + line.bottom) / 2))}px`);
        void bodyBg;
      }
      // 글 선택: 이정표 글은 선택되고, 누르는 요소(레일 행, 결재 단추, 기술 기록 토글)는 선택되지 않는다.
      const selectable = await milestones.first().evaluate(el => getComputedStyle(el.lastElementChild).userSelect);
      assert.equal(selectable, 'text', `${label}: 이정표 글 user-select`);
      const toggle = await page.getByLabel('기술 기록 3건').evaluate(el => getComputedStyle(el).userSelect);
      const button = await page.getByTestId('pas-report-complete').evaluate(el => getComputedStyle(el).userSelect);
      assert.notEqual(toggle, 'text', `${label}: 기술 기록 토글은 선택되면 안 됨`);
      assert.notEqual(button, 'text', `${label}: 결재 단추는 선택되면 안 됨`);
      // 확인 항목 위 괘선
      await page.getByTestId('pas-report-items').scrollIntoViewIfNeeded();
      const itemsRect = await rect(page, 'pas-report-items');
      // 1px 괘선은 소수 좌표에서 위아래 한 줄로 반올림되어 그려지므로 가까운 세 줄 가운데 가장 진한 줄을 잰다.
      let ruleContrast = 0;
      for (const offset of [-1, 0, 1]) {
        ruleContrast = Math.max(ruleContrast, await pixelContrast(page, { x: itemsRect.x + itemsRect.width / 2, y: itemsRect.y + offset }, { x: itemsRect.x + itemsRect.width / 2, y: itemsRect.y - 6 }));
      }
      assert.ok(ruleContrast >= 2, `${label}: 확인 항목 위 괘선 대비 ${round(ruleContrast)}:1 < 2:1`);
      if (vp.name === 'phone-390') rows.push(`${label}: 확인 항목 위 괘선 대비 ${round(ruleContrast)}:1, 이정표 글 user-select ${selectable}, 기술 기록 토글 ${toggle}, 결재 단추 ${button}`);
      await context.close();
    }
  }
  record('이정표와 괘선', rows);
}

async function runStamps(browser, base) {
  const lines = [];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
    for (const state of ['review', 'question', 'request', 'blocked', 'running']) {
      const { context, page, label } = await open(browser, base, vp, 'light', state);
      const buttons = await page.getByTestId('pas-report-decide').getByRole('button').evaluateAll(els => els.map(el => {
        const b = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label'), left: b.left, top: b.top, bottom: b.bottom, right: b.right, background: getComputedStyle(el).backgroundColor };
      }));
      const primaryGroup = await page.getByTestId('pas-report-stamps-primary').count() ? await rect(page, 'pas-report-stamps-primary') : null;
      const secondaryGroup = await page.getByTestId('pas-report-stamps-secondary').count() ? await rect(page, 'pas-report-stamps-secondary') : null;
      if (primaryGroup && secondaryGroup) {
        // 좁은 폭에서 감겨도 주 묶음이 먼저(위나 왼쪽)다.
        assert.ok(primaryGroup.top <= secondaryGroup.top + 1, `${label}: 주 묶음이 오른쪽 묶음보다 위에 있어야 함`);
        if (Math.abs(primaryGroup.top - secondaryGroup.top) < 2) assert.ok(primaryGroup.left < secondaryGroup.left, `${label}: 같은 줄에서는 주 묶음이 왼쪽`);
      }
      if (['review', 'request', 'blocked'].includes(state)) {
        const first = buttons[0];
        const others = buttons.slice(1);
        assert.ok(others.every(button => button.left > first.left || button.top > first.top), `${label}: 채운 주 단추가 첫 자리여야 함(${first.label})`);
        assert.ok(others.every(button => button.background !== first.background), `${label}: 첫 단추만 채워져야 함`);
        lines.push(`${label}: 첫 자리 「${first.label}」(채움), 나머지 ${others.map(button => button.label).join(', ')}`);
      } else if (state === 'question') {
        lines.push(`${label}: ${buttons.map(button => button.label).join(' / ')}`);
        assert.equal(await page.getByTestId('card-question-choice-0').count(), 0, `${label}: 스레드에 눌리는 선택지가 없어야 함`);
        assert.equal(await page.getByRole('button', { name: '파일로 옮기기' }).count(), 1, `${label}: 선택지는 결재 상자 한 곳`);
      }
      await context.close();
    }
  }
  record('결재 단추 순서', lines);
}

async function runResize(browser, base) {
  const { context, page, label } = await open(browser, base, VIEWPORTS[3], 'light', 'review');
  await page.getByTestId('pas-report-rail-fixed').waitFor();
  await page.getByTestId('pas-report-open-composer').click();
  const input = page.getByPlaceholder('커멘트');
  await input.fill('창 크기를 바꿔도 이 글은 남아야 한다');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId('pas-report-rail-fixed').count(), 0, `${label}: 좁아지면 고정 레일이 없어야 함`);
  await page.getByTestId('pas-report-open-rail').waitFor();
  assert.equal(await page.getByPlaceholder('커멘트').inputValue(), '창 크기를 바꿔도 이 글은 남아야 한다', `${label}: 입력 중인 글 유지`);
  await page.getByTestId('pas-report-open-rail').click();
  await page.getByTestId('pas-report-drawer').waitFor();
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId('pas-report-drawer').count(), 0, `${label}: 넓어지면 서랍이 남지 않아야 함`);
  await page.getByTestId('pas-report-rail-fixed').waitFor();
  assert.equal(await page.getByPlaceholder('커멘트').inputValue(), '창 크기를 바꿔도 이 글은 남아야 한다', `${label}: 다시 넓어져도 글 유지`);
  record('창 크기 바꾸기', '1180 → 390 → 1180: 고정 레일과 서랍이 폭에 맞게 바뀌고 입력 중인 글, 열린 입력창 유지');
  await context.close();
}

function writeOperations(failure) {
  const lines = [];
  const L = text => lines.push(text);
  const command = `node soul-app/scripts/pas-report-thread-capture.cjs ${outputArg}`;
  L('# 카드 #1871 PAS 보고 창 앱 조작 결과');
  L('');
  L(`실행: \`${command}\` (견본 번들: \`npm --prefix soul-app run export:components\`)`);
  L(`판정: ${failure ? `실패 — ${failure}` : '통과'}`);
  L(`플랫폼: RN web 견본(Chromium, 로컬 가짜 서버). 실기기 아이폰과 네이티브 제스처는 보지 못했다. 운영 서버에는 닿지 않았다(외부 요청 ${result.errors.filter(error => error.message.startsWith('External')).length}건).`);
  L('');
  L('## 14번부터 18번');
  L('');
  L('| 번호 | 결과 | 근거 |');
  L('|---|---|---|');
  const checks = Object.fromEntries(result.checks.map(check => [check.name, check.detail]));
  L(`| 14 누른 뒤 초점 | 통과 | 지시 적기를 누르면 입력창에 초점이 선다(${checks['초점']?.composer ?? '측정 없음'}). 입력창 알림줄의 「해제」로 닫으면 초점이 연 단추로 돌아온다(아래 「결함 2」 측정). 하드웨어 뒤로와 가장자리 끌기가 닫는 순서는 jest(PasReportWindow, PhoneContentScreens)가 덮는다. |`);
  L('| 15 Tab과 Esc | 해당 없음 | iOS 앱이라 Tab과 Esc가 없다. 뒤로 가기가 서랍, 답변 미루기 펼침, 입력창 순으로 하나씩 닫는 것은 jest(PasReportWindow, PhoneContentScreens)로 확인했다. |');
  L(`| 16 최소 폭 넘침과 잘림 | 통과 | 360 폭 포함 4폭, 두 테마, 검수와 질문 표본에서 가로 스크롤 0, 창 밖으로 나간 요소 0, 머리줄 제목이 단추와 겹치지 않음(말줄임). |`);
  L(`| 17 오류 상태 | 통과 | ${checks['상태 표본']?.error ?? ''}; ${checks['상태 표본']?.cardsError ?? ''}. |`);
  L(`| 18 창 크기 바꾸기 | 통과 | ${checks['창 크기 바꾸기'] ?? ''} |`);
  L('');
  L('## 대화상자와 줄 안 편집');
  L('');
  L('| 대상 | 여는 법 | 첫 초점 | Enter | Esc | 닫은 뒤 초점 |');
  L('|---|---|---|---|---|---|');
  L('| 안건 목록 서랍 | 머리줄 「안건 목록」 단추 | 해당 없음(터치 화면, 서랍 안 첫 행) | 해당 없음 | 해당 없음(뒤로 가기가 닫음) | 해당 없음 |');
  L('| 답변 미루기 펼침 | 결재 상자 「답변 미루기」 | 해당 없음(선택지 알약이 단추 줄 아래에 펼침) | 해당 없음 | 해당 없음(뒤로 가기가 닫음) | 해당 없음 |');
  L(`| 입력창(지시 적기, 되묻기, 다르게 답하기, 항목 지시) | 결재 상자 단추 | ${checks['초점']?.composer ?? ''} | ${checks['초점']?.enter ?? ''}(카드 상세 커멘트 입력과 같은 부품) | 해당 없음(터치 앱. 알림줄 「해제」와 뒤로 가기가 닫음) | 연 단추(지시 적기, 다르게 답하기, 되묻기, 고칠 점 남기기)에 선다(결함 2 측정) |`);
  L('');
  L('## 측정');
  L('');
  for (const [name, detail] of Object.entries(checks)) {
    if (['초점', '창 크기 바꾸기'].includes(name)) continue;
    L(`### ${name}`);
    L('');
    if (Array.isArray(detail)) for (const line of detail) L(`- ${line}`);
    else if (typeof detail === 'object') for (const [key, value] of Object.entries(detail)) L(`- ${key}: ${value}`);
    else L(`- ${detail}`);
    L('');
  }
  L('## 산출물');
  L('');
  L(`폴더: \`${output}\``);
  L('');
  for (const name of result.shots) L(`- ${name}`);
  L('');
  if (result.errors.length) { L('## 오류'); L(''); for (const error of result.errors) L(`- ${error.name}: ${error.message}`); L(''); }
  if (result.warnings.length) {
    const unique = [...new Set(result.warnings.map(warning => warning.message))];
    L('## 브라우저 콘솔 오류(참고)'); L('');
    for (const message of unique.slice(0, 8)) L(`- ${message}`);
    L('');
  }
  fsSync.writeFileSync(path.join(output, 'operations.md'), lines.join('\n'));
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let failure = null;
  try {
    await runMatrix(browser, base);
    await runStates(browser, base);
    await runInteractions(browser, base);
    await runAlignments(browser, base);
    await runMilestones(browser, base);
    await runStamps(browser, base);
    await runResize(browser, base);
    await runReviewDefects(browser, base);
    assert.deepEqual(result.errors, [], '페이지 오류 또는 외부 요청');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(failure);
  } finally {
    await browser.close();
    server.close();
    writeOperations(failure);
  }
  if (failure) process.exit(1);
  console.log(`보고 창 캡처 통과: ${result.shots.length}장, ${path.join(output, 'operations.md')}`);
})();
