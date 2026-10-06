// Run under heavy_verify.py. Playwright is supplied by the caller; it is not an
// app runtime dependency. Only this process's local fixture server is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const [playwrightPath, evidencePath, tabletSize, captureMode] = process.argv.slice(2);
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

async function openCardChecksState(page, base, { phone = false, state = 'normal', theme = 'dark' }) {
  const url = new URL(`${base}${prefix}index.html`);
  url.searchParams.set('section', 'cardChecks');
  url.searchParams.set('safeArea', 'fixture');
  url.searchParams.set('state', state);
  url.searchParams.set('theme', theme);
  await page.goto(url.toString());
  if (phone) await page.getByTestId('postit-open-public-card-checks').click();
  await page.getByTestId('card-detail-header').waitFor();
}

async function captureCardAfterFix(page, base, { phone, shot, name }) {
  await openCardChecksState(page, base, { phone, state: 'normal', theme: 'dark' });
  await page.getByTestId('card-check-item-1-fix').click();
  await page.getByTestId('card-comment-target').waitFor();
  const input = page.getByTestId('card-comment-composer').getByTestId('chat-composer-text-input');
  await input.fill('시안과 같은 표시인지 확인해 주세요.');
  await page.getByTestId('card-comment-composer').getByTestId('chat-composer-send-button').click();
  await page.getByTestId('card-comment-send-notice').waitFor();
  await page.getByText('고칠 점 1', { exact: true }).waitFor();
  await shot('after-fix');
  result.interactions.push(`${name}: 1번 항목 대상 커멘트 뒤 붉은 고칠 점 상태`);
}

async function captureAllChecked(page, base, { phone, shot, name }) {
  await openCardChecksState(page, base, { phone, state: 'all-confirmed', theme: 'dark' });
  await page.getByText('모두 확인했습니다. 완료로 옮길까요?').waitFor();
  await page.getByTestId('card-check-items-confirmed-group').waitFor();
  await shot('all-checked');
  await shot('all-confirmed');
  const mutations = await page.evaluate(() => window.__soulAppEntryShellCardMutations ?? null);
  assert.ok(Array.isArray(mutations), '상태 변경 기록기가 연결되지 않았습니다.');
  assert.equal(mutations.filter((entry) => entry.id === 'public-card-checks'
    && (entry.method === 'setCardStatus' || entry.method === 'executeCard')).length, 0);
  result.interactions.push(`${name}: 전부 확인된 화면에서 완료 강조와 자동 상태 변경 없음`);
}

async function runCardChecksViewport(browser, base, { name, width, height, state = 'normal', theme = 'light', phone = false }) {
  const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: true });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.errors.push({ name, message: error.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') result.warnings.push({ name, message: msg.text() });
  });
  await page.addInitScript(() => {
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
  const url = new URL(base + prefix + 'index.html');
  url.searchParams.set('section', 'cardChecks');
  url.searchParams.set('safeArea', 'fixture');
  url.searchParams.set('state', state);
  url.searchParams.set('theme', theme);
  await page.goto(url.toString());
  await page.getByTestId('card-checks-review-entry').waitFor();
  const shot = async (part) => page.screenshot({ path: path.join(output, name + '-' + part + '.png') });
  const metric = async (id) => page.getByTestId(id).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
  });
  result.viewports.push({ name, viewport: { width, height }, state, theme });

  if (captureMode === 'card-trim') {
    if (phone) await page.getByTestId('postit-open-public-card-checks').click();
    await page.getByTestId('card-detail-header').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const panelBefore = await metric('card-now-panel');
    const firstItemBefore = await metric('card-check-item-1');
    await shot('detail-initial');
    assert.equal(await page.getByTestId('card-check-item-1-status').count(), 0);
    assert.equal(await page.getByTestId('card-now-turn-band').getByText('내 차례', { exact: true }).count(), 0);
    assert.match(await page.getByTestId('card-now-turn-band').getAttribute('aria-label'), /내 차례/);
    await shot('user-turn');
    await page.getByLabel('이전 상황').click();
    const panelPast = await metric('card-now-panel');
    const firstItemPast = await metric('card-check-item-1');
    assert.equal(panelBefore.height, panelPast.height);
    assert.equal(firstItemBefore.y, firstItemPast.y);
    assert.equal(await page.getByText('아래 확인 항목은 지금 상태입니다.', { exact: true }).count(), 0);
    await shot('past');
    result.viewports[result.viewports.length - 1].history = { panelBefore, panelPast, firstItemBefore, firstItemPast };
    await page.getByTestId('card-now-latest').click();
    await page.getByTestId('card-check-item-4-caveat').scrollIntoViewIfNeeded();
    await shot('caveat');
    const caveat = await metric('card-check-item-4-caveat');
    const resultBottom = await page.getByText('수정 뒤 다시 확인할 결과입니다.', { exact: true }).evaluate(el => el.getBoundingClientRect().bottom);
    assert.ok(caveat.y >= resultBottom);
    await page.getByTestId('card-check-item-3-evidence-0').scrollIntoViewIfNeeded();
    assert.equal(await page.getByText('화면 캡처 공개 예시', { exact: true }).count(), 0);
    await page.getByTestId('card-check-item-3-evidence-0').click();
    await page.getByTestId('image-viewer-caption-0').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="image-viewer-caption-0"]')?.getBoundingClientRect().bottom <= innerHeight);
    await shot('image-caption');
    await page.getByLabel('이미지 닫기').click();
    await page.getByTestId('settings-segment-card-detail-sessions').click();
    await page.getByTestId('task-run-row-public-shell-session-1').waitFor();
    await shot('sessions');
    await page.getByTestId('task-run-row-public-shell-session-1').click();
    if (phone) {
      await page.getByTestId('card-detail-header').waitFor({ state: 'hidden' });
      await page.goto(url.toString());
      await page.getByTestId('postit-open-public-card-checks').click();
    } else await page.getByTestId('card-detail-header').waitFor();
    await page.getByTestId('settings-segment-card-detail-notes').click();
    await page.getByTestId('card-brief-frame').waitFor();
    await shot('notes');
    result.interactions.push(`${name}: 상황판 높이·항목 y 유지, 상태 글 제거, caveat→증거, 이미지 캡션·닫기, 세션 선택, 노트 프레임`);
    await context.close();
    return;
  }

  if (phone) {
    const row = page.getByTestId('postit-open-public-card-checks');
    await row.waitFor();
    await page.getByTestId('postit-public-card-checks-item-summary').waitFor();
    await shot('list');
    await row.click();
    await page.getByTestId('card-detail-header').waitFor();
    await page.getByTestId('card-check-item-2-shimmer').waitFor();
    await page.getByTestId('card-detail-dock').waitFor();
    const header = await metric('card-detail-header');
    const dock = await metric('card-detail-dock');
    const dockBottomInset = height - dock.bottom;
    assert.ok(header.y >= 47, `phone header must begin below the 47pt top safe area: ${JSON.stringify(header)}`);
    assert.equal(Math.round(dockBottomInset), 42, `phone dock must end 42pt above the screen edge: ${JSON.stringify(dock)}`);
    result.viewports[result.viewports.length - 1].phoneFrame = { header, dock, dockBottomInset };
    await shot('detail-initial');
    await shot('still');
    const panelBefore = await metric('card-now-panel');
    const firstItemBefore = await metric('card-check-item-1');
    await page.getByLabel('이전 상황').click();
    const panelPast = await metric('card-now-panel');
    const firstItemPast = await metric('card-check-item-1');
    assert.equal(Math.round(panelBefore.height), Math.round(panelPast.height), JSON.stringify({ panelBefore, panelPast }));
    assert.equal(Math.round(firstItemBefore.y), Math.round(firstItemPast.y), JSON.stringify({ firstItemBefore, firstItemPast }));
    await shot('past');
    await page.getByTestId('card-now-latest').click();
    await page.getByTestId('card-check-item-5-fix').click();
    await page.getByTestId('card-comment-target').waitFor();
    const input = page.getByTestId('card-comment-composer').getByTestId('chat-composer-text-input');
    await input.fill('수정 결과를 확인해 주세요.');
    await page.getByTestId('card-comment-composer').getByTestId('chat-composer-send-button').click();
    await page.getByTestId('card-comment-send-notice').waitFor();
    assert.equal(await page.getByTestId('settings-segment-card-detail-items').getAttribute('aria-pressed'), 'true');
    const requests = await page.evaluate(() => window.__cardChecksRequests ?? []);
    assert.ok(requests.some((entry) => entry.kind === 'comment' && entry.data.itemId === 5), '항목 커멘트는 itemId를 포함해야 합니다.');
    await shot('target-and-sent');
    await page.getByTestId('settings-segment-card-detail-comments').click();
    await page.getByTestId('card-timeline').waitFor();
    await shot('comments');
    await page.getByTestId('settings-segment-card-detail-items').click();
    await page.getByTestId('card-check-item-3-evidence-0').scrollIntoViewIfNeeded();
    await page.getByTestId('card-check-item-3-evidence-0').click();
    await page.getByLabel('이미지 닫기').waitFor();
    await shot('image-expanded');
    await page.getByLabel('이미지 닫기').click();
    await page.getByLabel('뒤로').click();
    await page.getByTestId('postit-open-public-card-checks').waitFor();
    assert.equal(await page.getByTestId('card-detail-header').count(), 0);
    await shot('list-after-back');
    result.interactions.push(`${name}: 실제 카드 행→상세→대상 커멘트(itemId 5)→이미지 확대·닫기→뒤로가기 목록 복귀`);

    await page.goto(new URL(`${base}${prefix}index.html?section=cardChecks&safeArea=fixture&state=legacy&theme=light`).toString());
    await page.getByTestId('postit-open-public-card-checks').click();
    await page.getByTestId('card-timeline').waitFor();
    assert.equal(await page.getByTestId('settings-segment-card-detail-comments').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('card-now-panel').count(), 0);
    await shot('legacy-comments');
    result.interactions.push(`${name}: 신규 fields가 없는 옛 카드의 커멘트 탭과 기존 시간순 타임라인`);
    await captureCardAfterFix(page, base, { phone: true, shot, name });
    await captureAllChecked(page, base, { phone: true, shot, name });
  } else {
    await page.getByTestId('card-detail-header').waitFor();
    await page.getByTestId('task-workspace-chat-pane').waitFor();
    const taskPane = await metric('task-workspace-task-pane');
    const chatPane = await metric('task-workspace-chat-pane');
    const safeFrame = await metric('tablet-safe-area-content');
    const expectedPaneWidth = Math.round(Math.min(Math.floor(width * 0.9), 920) / 2);
    assert.equal(Math.round(taskPane.width), expectedPaneWidth);
    assert.equal(Math.round(chatPane.width), expectedPaneWidth);
    assert.equal(Math.round(safeFrame.y), 36);
    result.viewports[result.viewports.length - 1].tabletFrame = { taskPane, chatPane, safeFrame };
    await shot('detail-initial');
    await shot('still');
    const panelBefore = await metric('card-now-panel');
    const panelFrameBefore = await metric('card-now-panel-frame');
    const firstItemBefore = await metric('card-check-item-1');
    await page.getByLabel('이전 상황').click();
    const panelPast = await metric('card-now-panel');
    const panelFramePast = await metric('card-now-panel-frame');
    const firstItemPast = await metric('card-check-item-1');
    result.viewports[result.viewports.length - 1].nowPanelLayout = {
      panelBefore, panelPast, panelFrameBefore, panelFramePast, firstItemBefore, firstItemPast,
    };
    assert.equal(Math.round(panelBefore.height), Math.round(panelPast.height), JSON.stringify({ panelBefore, panelPast, panelFrameBefore, panelFramePast }));
    assert.equal(Math.round(firstItemBefore.y), Math.round(firstItemPast.y), JSON.stringify({ firstItemBefore, firstItemPast }));
    await shot('past');
    await shot('past-now');
    await page.getByTestId('settings-segment-card-detail-sessions').click();
    await page.getByTestId('card-sessions').waitFor();
    await shot('sessions-and-chat');
    await page.getByTestId('settings-segment-card-detail-notes').click();
    await page.getByTestId('card-notes').waitFor();
    await page.getByText('인계 요약', { exact: true }).waitFor();
    await page.getByText('앞선 노트 10건', { exact: true }).waitFor();
    await page.getByText('인계 노트 11의 공개 예시입니다.', { exact: true }).waitFor();
    assert.equal(await page.getByText('인계 노트 10의 공개 예시입니다.', { exact: true }).count(), 0);
    await shot('notes');
    await page.getByTestId('settings-segment-card-detail-sessions').click();
    await page.getByTestId('card-sessions').waitFor();
    const chatHeader = page.getByTestId('tablet-chat-header');
    const chatBefore = (await chatHeader.textContent())?.trim() ?? '';
    const sessionRow = page.getByTestId('task-run-row-public-shell-session-1');
    await sessionRow.waitFor();
    await sessionRow.click();
    await page.waitForFunction((previous) => {
      const current = document.querySelector('[data-testid="tablet-chat-header"]')?.textContent?.trim() ?? '';
      return current.length > 0 && current !== previous;
    }, chatBefore);
    const chatAfter = (await chatHeader.textContent())?.trim() ?? '';
    assert.notEqual(chatAfter, chatBefore, '세션 행을 눌러도 오른쪽 대화가 바뀌지 않았습니다.');
    await page.getByLabel('뒤로').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="task-workspace-overlay"]')
      && getComputedStyle(document.querySelector('[data-testid="task-workspace-overlay"]')).pointerEvents === 'none')
      || document.querySelector('[data-testid="task-workspace-sheet"]') === null);
    result.interactions.push(`${name}: TabletSafeAreaFrame 0이 아닌 안전 영역·카드/채팅 반반 폭·상황 넘김·세션 선택·카드 작업면 닫기`);

    if (name === 'ipad-landscape-1210x834') {
      await page.goto(new URL(`${base}${prefix}index.html?section=cardChecks&safeArea=fixture&state=normal&theme=light`).toString());
      await page.getByTestId('card-detail-header').waitFor();
      await page.getByTestId('settings-segment-card-detail-notes').click();
      await page.getByText('앞선 노트 10건').waitFor();
      await page.getByText('앞선 노트 10건').click();
      await page.getByText('인계 노트 1의 공개 예시입니다.').waitFor();
      await shot('notes-expanded');
      result.interactions.push(`${name}: 인계 요약·최근 노트 5건·앞선 노트 펼침`);
    }
    await captureCardAfterFix(page, base, { phone: false, shot, name });
    await captureAllChecked(page, base, { phone: false, shot, name });
  }

  await context.close();
}

async function runCardChecksCaptures(browser, base) {
  const phone = await browser.newPage({ viewport: { width: 428, height: 926 } });
  await phone.goto(base + prefix + 'index.html');
  await phone.getByText('로그인 후 앱 컴포넌트 검수로 돌아가기', { exact: true }).waitFor();
  assert.equal(await phone.getByTestId('component-review').count(), 0);
  await phone.close();
  result.interactions.push('미인증 카드 검수 URL: gallery mount 차단');
  await runCardChecksViewport(browser, base, { name: 'iphone-428x926', width: 428, height: 926, phone: true, state: 'normal', theme: 'dark' });
  await runCardChecksViewport(browser, base, { name: 'ipad-portrait-834x1210', width: 834, height: 1210, state: 'normal', theme: 'dark' });
  await runCardChecksViewport(browser, base, { name: 'ipad-landscape-1210x834', width: 1210, height: 834, state: 'normal', theme: 'dark' });
}

async function runManuscriptChatCaptures(browser, base) {
  const scenarios = [
    { name: 'iphone-light-350', width: 390, height: 844, columnWidth: 350, theme: 'light', mobile: true },
    { name: 'iphone-dark-350', width: 390, height: 844, columnWidth: 350, theme: 'dark', mobile: true },
    { name: 'ipad-light-400', width: 834, height: 1194, columnWidth: 400, theme: 'light', mobile: false },
    { name: 'ipad-dark-400', width: 834, height: 1194, columnWidth: 400, theme: 'dark', mobile: false },
    { name: 'ipad-light-480', width: 834, height: 1194, columnWidth: 480, theme: 'light', mobile: false },
    { name: 'ipad-dark-480', width: 834, height: 1194, columnWidth: 480, theme: 'dark', mobile: false },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      screen: { width: scenario.width, height: scenario.height },
      deviceScaleFactor: 1,
      isMobile: scenario.mobile,
      hasTouch: true,
    });
    await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => result.errors.push({ name: scenario.name, message: error.message }));
    await page.addInitScript((theme) => {
      localStorage.setItem('soul-app-settings', JSON.stringify({ state: { appearance: theme }, version: 0 }));
    }, scenario.theme);
    await page.goto(`${base}${prefix}index.html?section=chat&theme=${scenario.theme}&pasColumnWidth=${scenario.columnWidth}`);
    await page.getByTestId('component-review').waitFor();
    const sample = page.getByTestId('manuscript-presentation-scroll');
    await sample.scrollIntoViewIfNeeded();
    const captureGeometry = async (presentation) => {
      const column = page.getByTestId(`manuscript-presentation-column-${presentation}`);
      const rect = (locator) => locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom']
          .map((key) => [key, Math.round(box[key] * 10) / 10]));
      });
      const columnRect = await rect(column);
      const relative = async (locator) => {
        const box = await rect(locator);
        return { ...box, leftInset: Math.round((box.x - columnRect.x) * 10) / 10,
          rightInset: Math.round((columnRect.right - box.right) * 10) / 10 };
      };
      const composerBoxes = column.getByTestId('chat-composer-box');
      const composerUnderlines = await Promise.all(Array.from({ length: await composerBoxes.count() }, (_, index) =>
        relative(composerBoxes.nth(index))));
      const attachmentGlyphBounds = async (attachVisual) => attachVisual.evaluate((element) => {
        const icon = element.querySelector('svg');
        if (icon) {
          const box = icon.getBoundingClientRect();
          return Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom']
            .map((key) => [key, Math.round(box[key] * 10) / 10]));
        }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (box.width && box.height) {
            const fontSize = Number.parseFloat(getComputedStyle(node.parentElement).fontSize);
            const glyphInset = fontSize * (3 / 16);
            const ink = {
              x: box.x + glyphInset,
              y: box.y,
              width: box.width - glyphInset * 2,
              height: box.height,
            };
            ink.right = ink.x + ink.width;
            ink.bottom = ink.y + ink.height;
            return Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom']
              .map((key) => [key, Math.round(ink[key] * 10) / 10]));
          }
        }
        const box = element.getBoundingClientRect();
        return Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom']
          .map((key) => [key, Math.round(box[key] * 10) / 10]));
      });
      const composerCount = await composerBoxes.count();
      const composerControls = await Promise.all(Array.from({ length: composerCount }, async (_, index) => {
        const attachmentGlyph = await attachmentGlyphBounds(column.getByTestId('chat-composer-attach-visual').nth(index));
        const sendVisual = await rect(column.getByTestId('chat-composer-send-visual').nth(index));
        return {
          attachmentGlyph: { ...attachmentGlyph,
            leftInset: Math.round((attachmentGlyph.x - columnRect.x) * 10) / 10,
            rightInset: Math.round((columnRect.right - attachmentGlyph.right) * 10) / 10 },
          sendVisual: { ...sendVisual,
            leftInset: Math.round((sendVisual.x - columnRect.x) * 10) / 10,
            rightInset: Math.round((columnRect.right - sendVisual.right) * 10) / 10 },
        };
      }));
      const geometry = {
        column: columnRect,
        assistantBody: await relative(column.getByTestId('assistant-message-bubble').first()),
        userMessage: await relative(column.getByTestId('user-message-bubble').first()),
        jevCaption: await relative(column.getByTestId('collapsible-caption-wrapper')),
        generationLeftLine: await relative(column.getByTestId('labeled-divider-left-line')),
        generationRightLine: await relative(column.getByTestId('labeled-divider-right-line')),
        generationLabel: await relative(column.getByText('새 세대', { exact: true })),
        composerUnderlines,
        composerControls,
        approvalLabel: await relative(column.getByText('도구 승인', { exact: true })),
        errorText: await relative(column.getByText(/오류: 도구 요청에서 발생한 오류/)),
      };
      if (presentation === 'manuscript') {
        const aligned = [
          geometry.assistantBody.leftInset,
          geometry.userMessage.rightInset,
          geometry.jevCaption.leftInset,
          geometry.jevCaption.rightInset,
          geometry.generationLeftLine.leftInset,
          geometry.generationRightLine.rightInset,
          geometry.composerUnderlines[0].leftInset,
          geometry.composerUnderlines[0].rightInset,
          geometry.composerUnderlines[1].leftInset,
          geometry.composerUnderlines[1].rightInset,
          ...geometry.composerControls.flatMap(({ attachmentGlyph, sendVisual }) => [
            attachmentGlyph.leftInset,
            sendVisual.rightInset,
          ]),
        ];
        if (aligned.some((inset) => Math.abs(inset) > 1)) {
          result.errors.push({ name: scenario.name, message: `manuscript edge alignment failed: ${JSON.stringify(geometry)}` });
        }
      }
      return geometry;
    };
    await sample.evaluate((element) => { element.scrollLeft = 0; });
    await page.screenshot({ path: path.join(output, `${scenario.name}-default.png`), fullPage: true });
    const defaultGeometry = await captureGeometry('default');
    await sample.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({ path: path.join(output, `${scenario.name}-manuscript.png`), fullPage: true });
    const manuscriptGeometry = await captureGeometry('manuscript');
    const persistentProjection = page.getByTestId('review-persistent-chat-projection');
    await persistentProjection.scrollIntoViewIfNeeded();
    const chatColumns = page.getByTestId('review-persistent-chat-columns');
    const defaultColumn = page.getByTestId('review-persistent-column-default');
    const manuscriptColumn = page.getByTestId('review-persistent-column-manuscript');
    const scrollColumnsTo = async (side) => chatColumns.evaluate((element, target) => {
      element.scrollLeft = target === 'manuscript' ? element.scrollWidth : 0;
    }, side);
    await scrollColumnsTo('default');
    const defaultTurnLine = defaultColumn.getByText(/— 턴 완료 · 입력 645,367/);
    await defaultTurnLine.waitFor();
    if (scenario.name === 'iphone-light-350') {
      await defaultColumn.screenshot({ path: path.join(output, `${scenario.name}-pas-default-invariant.png`) });
    }
    result.interactions.push(`${scenario.name}: 기본 ChatBody의 기존 턴 완료 줄 ${await defaultTurnLine.textContent()}`);

    await scrollColumnsTo('manuscript');
    if (scenario.name === 'iphone-light-350') {
      await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-pas-manuscript-collapsed.png`) });
    }
    const usageTitle = '컨텍스트 약 63.0% · 정가 $0.62';
    const usageCaption = manuscriptColumn.getByRole('button', { name: usageTitle, exact: true });
    await usageCaption.waitFor();
    assert.equal(await manuscriptColumn.getByText('컨텍스트 약 630,000 / 1,000,000 (63.0%)', { exact: true }).count(), 0);
    await usageCaption.scrollIntoViewIfNeeded();
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-collapsed.png`) });
    await usageCaption.click();
    const firstContextLine = manuscriptColumn.getByText('컨텍스트 약 630,000 / 1,000,000 (63.0%)', { exact: true });
    const firstStatsLine = manuscriptColumn.getByText(
      '턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)',
      { exact: true },
    );
    await firstContextLine.waitFor();
    await firstStatsLine.waitFor();
    assert.equal(await usageCaption.getByText(usageTitle, { exact: true }).count(), 0);
    const measureWrappedLine = async (line) => line.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        width: box.width,
        height: box.height,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        lineHeight: Number.parseFloat(style.lineHeight),
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    const firstLineMetrics = await measureWrappedLine(firstStatsLine);
    assert.equal(firstLineMetrics.text, '턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)');
    assert.ok(firstLineMetrics.scrollWidth <= firstLineMetrics.width + 1, JSON.stringify(firstLineMetrics));
    assert.ok(firstLineMetrics.height > firstLineMetrics.lineHeight + 1, JSON.stringify(firstLineMetrics));
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-expanded-turn1.png`) });

    const secondTurnTitle = '컨텍스트 22.0% · 정가 $1.40';
    const secondTurnCaption = manuscriptColumn.getByRole('button', { name: secondTurnTitle, exact: true });
    const costOnlyCaption = manuscriptColumn.getByRole('button', { name: '정가 $0.80', exact: true });
    const tokenOnlyCaption = manuscriptColumn.getByRole('button', { name: '입력 150 · 출력 35', exact: true });
    const errorUsageCaption = manuscriptColumn.getByRole('button', { name: '컨텍스트 약 41.5%', exact: true });
    assert.equal(await secondTurnCaption.count(), 1);
    assert.equal(await costOnlyCaption.count(), 1);
    assert.equal(await tokenOnlyCaption.count(), 1);
    assert.equal(await errorUsageCaption.count(), 1);
    await secondTurnCaption.scrollIntoViewIfNeeded();
    await secondTurnCaption.click();
    const secondContextLine = manuscriptColumn.getByText('컨텍스트 220,000 / 1,000,000 (22.0%)', { exact: true });
    const secondStatsLine = manuscriptColumn.getByText(
      '턴 완료 · 입력 1,304,874 (캐시 1,304,862) · 출력 18,244 · 정가 $1.40 (세션 $1,234.50)',
      { exact: true },
    );
    await secondContextLine.waitFor();
    await secondStatsLine.waitFor();
    assert.equal(await secondTurnCaption.getByText(secondTurnTitle, { exact: true }).count(), 0);
    const secondLineMetrics = await measureWrappedLine(secondStatsLine);
    assert.equal(secondLineMetrics.text, '턴 완료 · 입력 1,304,874 (캐시 1,304,862) · 출력 18,244 · 정가 $1.40 (세션 $1,234.50)');
    assert.ok(secondLineMetrics.scrollWidth <= secondLineMetrics.width + 1, JSON.stringify(secondLineMetrics));
    assert.ok(secondLineMetrics.height > secondLineMetrics.lineHeight + 1, JSON.stringify(secondLineMetrics));
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-expanded-turn2.png`) });

    await costOnlyCaption.scrollIntoViewIfNeeded();
    await costOnlyCaption.click();
    await manuscriptColumn.getByText('턴 완료 · 정가 $0.80', { exact: true }).waitFor();
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-cost-only.png`) });
    await tokenOnlyCaption.scrollIntoViewIfNeeded();
    await tokenOnlyCaption.click();
    await manuscriptColumn.getByText('턴 완료 · 입력 150 · 출력 35', { exact: true }).waitFor();
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-token-only.png`) });
    await errorUsageCaption.scrollIntoViewIfNeeded();
    await errorUsageCaption.click();
    await manuscriptColumn.getByText('컨텍스트 약 415,000 / 1,000,000 (41.5%)', { exact: true }).waitFor();
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-error-expanded.png`) });
    const noUsageAssistant = manuscriptColumn.getByText('사용량이 없으면 아래 사용량 줄을 표시하지 않습니다.', { exact: true });
    await noUsageAssistant.scrollIntoViewIfNeeded();
    assert.equal(await manuscriptColumn.getByRole('button', { name: '턴 완료', exact: true }).count(), 0);
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-no-value-complete.png`) });
    await page.getByTestId('review-persistent-turn-usage-toggle').click();
    await usageCaption.waitFor({ state: 'detached' });
    await manuscriptColumn.getByText(/예시 오류: 연결이 끊겼습니다/).waitFor();
    await manuscriptColumn.getByText('다음 턴의 응답입니다.', { exact: true }).waitFor();
    await manuscriptColumn.getByText(/예시 오류: 연결이 끊겼습니다/).scrollIntoViewIfNeeded();
    await manuscriptColumn.screenshot({ path: path.join(output, `${scenario.name}-usage-disabled.png`) });
    result.interactions.push(`${scenario.name}: ChatBody usage 접힘·펼침, production-sized 통계 줄바꿈, 빈 완료 감춤, 비용/토큰 전용, 두 턴 분리, 오류 유지와 표시 끔`);
    await page.getByTestId('chat-composer-text-input').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${scenario.name}-manuscript-composer.png`) });
    result.viewports.push({ name: scenario.name, viewport: { width: scenario.width, height: scenario.height },
      columnWidth: scenario.columnWidth, theme: scenario.theme, geometry: { default: defaultGeometry, manuscript: manuscriptGeometry } });
    await context.close();
  }
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
    if (captureMode === 'card-checks' || captureMode === 'card-trim') {
      await runCardChecksCaptures(browser, base);
    } else if (captureMode === 'manuscript-chat') {
      await runManuscriptChatCaptures(browser, base);
    } else {
      const phone = devices['iPhone 14 Pro Max'];
      await runViewport(browser, base, { ...phone, defaultBrowserType: undefined }, 'iphone14-pro-max');
      if (tabletSize) {
        const [width, height] = tabletSize.split('x').map(Number);
        assert.ok(width > height && height >= 700, '확인된 iPad 가로 논리 해상도가 필요합니다.');
        await runViewport(browser, base, { viewport: { width, height }, hasTouch: true }, 'confirmed-ipad-landscape');
      }
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
