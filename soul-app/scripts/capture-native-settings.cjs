// Run under heavy_verify.py. Playwright is supplied by the caller; it is not an
// app runtime dependency. Only this process's local fixture server is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const [playwrightPath, evidencePath, phase = 'final', scenario = 'all'] = process.argv.slice(2);
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
    for (const viewport of [{ width: 390, height: 844 }, { width: 834, height: 1194 }]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      if (scenario === 'recurring-feedback') {
        const openJobs = async state => {
          await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=modal&state=${state}`);
          await page.getByTestId('settings-modal-header').waitFor();
          await page.getByTestId('settings-category-recurring-jobs').click();
          await page.getByTestId('recurring-jobs-list').waitFor();
        };
        await page.goto(`${base}${prefix}index.html?section=rows`);
        await page.getByTestId('review-card-rows').screenshot({ path: path.join(output, `${phase}-unchanged-rows-${viewport.width}.png`) });
        await openJobs('recurring-loading');
        assert.equal(await page.getByText('등록된 반복 작업이 없습니다.').count(), 0);
        await page.screenshot({ path: path.join(output, `${phase}-recurring-loading-${viewport.width}.png`) });
        for (const kind of ['existing', 'new']) {
          await openJobs('recurring-save-error');
          if (kind === 'existing') await page.getByTestId('recurring-job-review-job-0').click();
          else await page.getByText('새 작업', { exact: true }).click();
          const name = page.getByLabel('작업 이름', { exact: true });
          await name.fill(kind === 'existing' ? '매일 아침 프로젝트 진행 상황과 남은 작업 정리' : '매주 금요일 프로젝트 진행 상황과 다음 주 계획 정리');
          if (kind === 'new') await page.getByLabel('작업 내용', { exact: true }).fill('이번 주 완료한 작업과 남은 확인 사항을 정리하고 다음 주 계획을 알려 주세요.');
          const scroll = page.getByTestId('settings-jobs-editor-scroll');
          await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
          await page.getByTestId('settings-scope-save').click();
          const alert = page.getByRole('alert').filter({ hasText: 'HTTP 503' });
          await alert.waitFor();
          await page.waitForTimeout(700);
          const focusAfterSave = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), testID: document.activeElement?.getAttribute('data-testid') }));
          const rects = await page.evaluate(() => {
            const area = document.querySelector('[data-testid="settings-jobs-editor-scroll"]').getBoundingClientRect();
            const alert = Array.from(document.querySelectorAll('[role="alert"]')).find(el => el.textContent.includes('HTTP 503')).getBoundingClientRect();
            return { area: { top: area.top, bottom: area.bottom, left: area.left, right: area.right }, alert: { top: alert.top, bottom: alert.bottom, left: alert.left, right: alert.right } };
          });
          const visible = rects.alert.top >= rects.area.top - 1 && rects.alert.bottom <= rects.area.bottom + 1;
          console.log(`${viewport.width}px ${kind}: 오류 표시 ${visible ? '영역 안' : '영역 밖'} ${JSON.stringify(rects)}`);
          result.interactions.push({ viewport: viewport.width, kind, check: 'save error inside visible editor scroll', visible, rects, focusAfterSave });
          await page.screenshot({ path: path.join(output, `${phase}-recurring-${kind}-error-${viewport.width}.png`) });
          if (phase !== 'before') assert.ok(visible, `${kind} 오류가 스크롤 영역 밖입니다: ${JSON.stringify(rects)}`);
          if (kind === 'existing' && phase !== 'before') {
            await name.focus();
            await page.keyboard.press('Tab');
            const tabFocus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
            assert.equal(tabFocus, '작업 내용');
            await name.focus();
            await scroll.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
            await page.waitForTimeout(700);
            const scrollBefore = await scroll.evaluate(el => el.scrollTop);
            await page.setViewportSize({ width: viewport.width === 390 ? 834 : 390, height: viewport.height });
            await page.waitForTimeout(700);
            const scrollWideNarrow = await scroll.evaluate(el => el.scrollTop);
            assert.equal(await name.inputValue(), '매일 아침 프로젝트 진행 상황과 남은 작업 정리');
            assert.equal(await name.evaluate(el => document.activeElement === el), true, '폭 전환 뒤 입력 초점 유지');
            await page.setViewportSize({ width: 360, height: viewport.height });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
            assert.equal(overflow, false, '360px 가로 넘침');
            assert.equal(await name.inputValue(), '매일 아침 프로젝트 진행 상황과 남은 작업 정리');
            const focused = await name.evaluate(el => document.activeElement === el);
            assert.equal(focused, true, '크기 변경 뒤 입력 초점 유지');
            const scrollAfter = await scroll.evaluate(el => el.scrollTop);
            await page.setViewportSize(viewport);
            result.interactions.push({ viewport: viewport.width, check: 'tab and resize', tabFocus, overflow, draftRetained: true, focused, scrollBefore, scrollWideNarrow, scrollAfter });
          }
        }
        await context.close();
        continue;
      }
      await page.goto(`${base}${prefix}index.html?section=rows`);
      await page.getByTestId('review-card-rows').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.getByTestId('review-card-rows').screenshot({ path: path.join(output, `${phase}-unchanged-rows-${viewport.width}.png`) });
      const entries = viewport.width === 390 ? ['modal', 'tab', 'first'] : ['modal', 'first'];
      for (const entry of entries) {
        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=${entry}`);
        if (entry === 'tab') {
          await page.waitForTimeout(800);
          await page.screenshot({ path: path.join(output, `${phase}-${entry}-entry-${viewport.width}.png`) });
          const tabs = page.getByRole('tab');
          if (await tabs.count()) await tabs.last().click();
          else await page.mouse.click(viewport.width * 0.85, viewport.height - 58);
        }
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
            await page.getByTestId('provider-panel').waitFor();
            await page.getByTestId('provider-row-claude').waitFor();
            await page.getByTestId('provider-row-codex').waitFor();
            await page.getByTestId('provider-panel-updated').waitFor();
          }
          if (category === 'recurring-jobs') {
            await page.screenshot({ path: path.join(output, `${phase}-${entry}-jobs-list-${viewport.width}.png`) });
            await page.getByText('새 작업', { exact: true }).click();
            await page.getByLabel('작업 이름', { exact: true }).fill('공개 예시 보존 초안');
            await page.getByLabel('작업 내용', { exact: true }).fill('여러 줄 공개 예시\n두 번째 줄');
            await page.getByTestId('recurring-schedule-mode-monthly').click();
          }
          await page.screenshot({ path: path.join(output, `${phase}-${entry}-${category}-${viewport.width}.png`) });
          if (category === 'connection' && entry === 'modal') {
            const field = page.getByTestId('settings-server-input');
            const savedUrl = await field.inputValue();
            await field.fill('https://preserved-public-example.test');
            await field.focus();
            await page.setViewportSize({ width: viewport.width === 390 ? 834 : 390, height: viewport.height });
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
            if (viewport.width === 834) {
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
          const groups = await detail.evaluate(el => {
            const section = el.querySelector('[data-testid^="settings-section-"]');
            const frames = Array.from(section?.firstElementChild?.children ?? []);
            return frames.slice(0, 2).map(frame => { const r = frame.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width, height: r.height }; });
          });
          result.viewports.push({ entry, category, viewport, header: metrics, groups });
        }
      }
      for (const state of ['photo-fallback', 'nodes-error', 'usage-error', 'empty']) {
        const stateEntry = viewport.width === 390 ? 'tab' : 'modal';
        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=${stateEntry}&state=${state}`);
        if (stateEntry === 'tab') {
          await page.waitForTimeout(800);
          const tabs = page.getByRole('tab');
          if (await tabs.count()) await tabs.last().click();
          else await page.mouse.click(viewport.width * 0.85, viewport.height - 58);
        }
        await page.getByTestId('settings-modal-header').waitFor();
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
        if (state === 'usage-error') {
          await page.getByTestId('provider-panel-refresh').click();
          await page.getByTestId('provider-panel-refresh-error').waitFor();
        }
        if (state === 'empty') await page.getByText('등록된 반복 작업이 없습니다.', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, `${phase}-state-${state}-${viewport.width}.png`) });
        result.interactions.push({ viewport: viewport.width, check: `actual component ${state}` });
      }

      for (const theme of ['light', 'dark']) {
        const capture = (name) => page.screenshot({ path: path.join(output, `${phase}-${name}-${theme}-${viewport.width}.png`) });
        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=modal&safeArea=fixture&theme=${theme}`);
        await page.getByTestId('settings-modal-header').waitFor();
        await page.getByTestId('settings-category-display').click();
        await page.getByTestId('settings-persistent-session-open-on-start').waitFor();
        await capture('settings-open-on-start');
        result.interactions.push({ theme, viewport: viewport.width, check: 'account-scoped device preference displayed in full settings' });

        await page.goto(`${base}${prefix}index.html?section=nativeSettings&entry=modal&safeArea=fixture&theme=${theme}`);
        await page.getByTestId('settings-category-persistent').click();
        await page.getByTestId('persistent-session-review-pas-1').click();
        await page.getByTestId('persistent-session-editor').waitFor();
        await page.getByTestId('persistent-animate-character').waitFor();
        await capture('ordinary-persistent-editor');

        const pasUrl = (stateName = '', withSafeArea = true) => `${base}${prefix}index.html?section=pasSettings${withSafeArea ? '&safeArea=fixture' : ''}&theme=${theme}${stateName ? `&state=${stateName}` : ''}`;
        await page.goto(pasUrl());
        await page.getByTestId('persistent-session-pas-settings-modal').waitFor();
        await page.getByTestId('persistent-pas-settings-save').waitFor();
        await page.waitForTimeout(400);
        const safeArea = await page.getByTestId('persistent-session-pas-settings-safe-area').evaluate((el) => {
          const style = getComputedStyle(el);
          return { top: Number.parseFloat(style.paddingTop), bottom: Number.parseFloat(style.paddingBottom) };
        });
        assert.ok(safeArea.top > 0 && safeArea.bottom > 0, `비영 안전 영역 누락: ${JSON.stringify(safeArea)}`);
        const geometry = await page.getByTestId('persistent-session-pas-settings-modal').evaluate((root) => {
          const rect = (element) => {
            const bounds = element.getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
          };
          const section = root.querySelector('[data-testid="settings-section-persistent-editor-groups"]');
          const sectionSurface = section?.lastElementChild;
          return {
            header: rect(root.children[0]),
            headerTitle: rect(root.children[0].children[0]),
            selector: rect(root.children[1]),
            body: rect(root.children[2]),
            section: section ? rect(section) : null,
            sectionSurface: sectionSurface ? rect(sectionSurface) : null,
            selectedTab: rect(root.querySelector('[data-testid="settings-segment-pas-settings-account-model"]')),
            saveButton: rect(root.querySelector('[data-testid="persistent-pas-settings-save"]')),
          };
        });
        assert.equal(geometry.headerTitle.x, geometry.sectionSurface.x, '계정 카드와 헤더 제목의 왼쪽 선이 맞아야 합니다.');
        assert.equal(geometry.headerTitle.x, geometry.saveButton.x, '저장 버튼과 헤더 제목의 왼쪽 선이 맞아야 합니다.');
        await capture('pas-account-model');
        await page.getByText('7일 여유 12.5%', { exact: true }).scrollIntoViewIfNeeded();
        await capture('pas-account-quota');

        await page.goto(pasUrl('', false));
        await page.getByTestId('persistent-session-pas-settings-modal').waitFor();
        await page.getByTestId('persistent-pas-settings-save').waitFor();
        await page.waitForTimeout(400);
        const noSafeGeometry = await page.getByTestId('persistent-session-pas-settings-modal').evaluate((root) => {
          const section = root.querySelector('[data-testid="settings-section-persistent-editor-groups"]');
          return {
            headerTitleX: root.children[0].children[0].getBoundingClientRect().x,
            sectionX: section?.lastElementChild?.getBoundingClientRect().x ?? null,
            saveButtonX: root.querySelector('[data-testid="persistent-pas-settings-save"]')?.getBoundingClientRect().x ?? null,
          };
        });
        assert.equal(noSafeGeometry.headerTitleX, noSafeGeometry.sectionX, '안전 영역 0에서도 계정 카드와 헤더 제목의 왼쪽 선이 맞아야 합니다.');
        assert.equal(noSafeGeometry.headerTitleX, noSafeGeometry.saveButtonX, '안전 영역 0에서도 저장 버튼과 헤더 제목의 왼쪽 선이 맞아야 합니다.');
        await capture('pas-account-model-nosafe');

        await page.goto(pasUrl());
        await page.getByTestId('settings-segment-pas-settings-display').click();
        await page.getByTestId('persistent-show-character').waitFor();
        const displayCard = page.getByTestId('settings-section-persistent-editor-groups');
        const displayBox = await displayCard.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        });

        await capture('pas-display');
        await page.goto(pasUrl('pas-save-loading'));
        await page.getByTestId('settings-segment-pas-settings-display').click();
        await page.getByTestId('persistent-show-character').waitFor();
        const loadingCard = page.getByTestId('settings-section-persistent-editor-groups');
        const loadingBox = await loadingCard.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        });
        await page.getByTestId('persistent-show-character').click();
        await page.getByLabel('저장 중', { exact: true }).waitFor();
        const savingBox = await loadingCard.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        });
        assert.deepEqual(loadingBox, displayBox, '표시 섹션 진입이 카드의 위치나 높이를 바꾸면 안 됩니다.');
        assert.deepEqual(savingBox, displayBox, '표시 저장 중 상태가 카드의 위치나 높이를 바꾸면 안 됩니다.');
        await capture('pas-display-saving');

        await page.goto(pasUrl('persistent-save-error'));
        await page.getByTestId('settings-segment-pas-settings-display').click();
        await page.getByTestId('persistent-show-character').click();
        await page.getByText('저장 실패. 다시 눌러 주세요.', { exact: true }).waitFor();
        const failedBox = await page.getByTestId('settings-section-persistent-editor-groups').evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        });
        assert.deepEqual(failedBox, displayBox, '표시 저장 실패가 카드의 위치나 높이를 바꾸면 안 됩니다.');
        await capture('pas-display-saving-error');

        await page.goto(pasUrl());
        await page.getByTestId('settings-segment-pas-settings-history').click();
        await page.getByText('현재 세대', { exact: true }).waitFor();
        await capture('pas-records-values');
        await page.getByTestId('persistent-session-pas-close').click();
        await page.getByTestId('persistent-session-pas-settings-modal').waitFor({ state: 'hidden' });
        result.interactions.push({ theme, viewport: viewport.width, check: 'PAS settings close returns to review surface' });

        for (const monitorState of ['pas-monitor-empty', 'pas-monitor-loading', 'pas-monitor-error']) {
          await page.goto(pasUrl(monitorState));
          await page.getByTestId('settings-segment-pas-settings-history').waitFor();
          await page.getByTestId('settings-segment-pas-settings-history').click();
          const stateText = monitorState === 'pas-monitor-empty' ? '세대 기록 없음' : monitorState === 'pas-monitor-loading' ? '기록 불러오는 중' : '조회 실패';
          await page.getByLabel(stateText, { exact: true }).waitFor().catch(() => page.getByText(stateText, { exact: true }).first().waitFor());
          await page.waitForTimeout(400);
          await capture(`pas-records-${monitorState}`);
          if (monitorState === 'pas-monitor-error') {
            await page.getByTestId('persistent-session-monitoring-retry').click();
            await page.getByText('조회 실패', { exact: true }).waitFor();
            result.interactions.push({ theme, viewport: viewport.width, check: 'history retry runs in-place after timeline failure' });
          }
        }

        await page.goto(pasUrl());
        await page.getByTestId('persistent-session-pas-settings-modal').waitFor();
        await page.getByTestId('settings-segment-pas-settings-account-model').click();
        const beforeNameSave = await page.getByTestId('persistent-pas-settings-save').boundingBox();
        const nameField = page.getByLabel('세션 이름', { exact: true });
        await nameField.fill('공개 예시 이름 저장');
        await page.getByText('7일 여유 12.5%', { exact: true }).scrollIntoViewIfNeeded();
        await page.getByTestId('persistent-pas-settings-save').click();
        await page.waitForFunction(() => document.querySelector('[aria-label="세션 이름"]')?.value === '공개 예시 이름 저장');
        const afterNameSave = await page.getByTestId('persistent-pas-settings-save').boundingBox();
        assert.deepEqual(afterNameSave, beforeNameSave, '스크롤 저장 뒤 고정 footer 버튼이 같은 위치에 있어야 합니다.');

        for (const saveState of ['pas-save-loading', 'persistent-save-error']) {
          await page.goto(pasUrl(saveState));
          await page.getByTestId('persistent-session-pas-settings-modal').waitFor();
          await page.getByTestId('persistent-session-pas-editor').waitFor();
          await page.getByTestId('settings-segment-pas-settings-account-model').click();
          await page.getByLabel('세션 이름', { exact: true }).fill('공개 예시 저장 상태');
          await page.getByTestId('persistent-pas-settings-save').click();
          const stateText = saveState === 'pas-save-loading' ? '저장 중…' : '노드가 제때 응답하지 않았습니다.';
          if (saveState === 'pas-save-loading') await page.getByText(stateText, { exact: true }).waitFor();
          else await page.getByText(stateText, { exact: false }).first().waitFor();
          await page.waitForTimeout(400);
          await page.getByTestId('persistent-session-pas-settings-scroll').evaluate(el => { el.scrollTop = 0; });
          await capture(`pas-account-${saveState}`);
        }

        result.viewports.push({ theme, viewport: viewport.width, safeArea, geometry });
      }
      await context.close();
    }
    result.passed = result.errors.length === 0;
  } finally { await browser.close(); server.close(); await fs.writeFile(path.join(output, `${phase}-browser.json`), JSON.stringify(result, null, 2)); }
  if (!result.passed) throw new Error(result.errors.join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
