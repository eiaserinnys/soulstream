const assert = require('node:assert/strict');
const path = require('node:path');

async function runPersistentFullscreenCaptures({ browser, base, prefix, output, result }) {
  for (const scenario of [
    { name: 'ipad-l-light', viewport: { width: 1180, height: 820 }, theme: 'light', body: 152, column: 480, detail: 318 },
    { name: 'ipad-p-dark', viewport: { width: 820, height: 1180 }, theme: 'dark', body: 126, column: 400, detail: 340 },
  ]) {
    const context = await browser.newContext({ viewport: scenario.viewport, hasTouch: true });
    await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push({ name: scenario.name, message: error.message }));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('data:') || new URL(url).origin === base) return route.continue();
      result.errors.push({ name: scenario.name, message: 'External request: ' + url });
      await route.abort();
    });
    await page.goto(`${base}${prefix}index.html?section=persistent&sample=screen&safeArea=fixture&theme=${scenario.theme}`);
    try { await page.getByTestId('persistent-session-character-seat').waitFor(); }
    catch (error) {
      result.viewports.push({ name: scenario.name, text: await page.locator('body').innerText(),
        elements: await page.getByTestId(/persistent|chat-composer/).evaluateAll(elements => elements.map(element => ({ id: element.getAttribute('data-testid'), box: element.getBoundingClientRect().toJSON() }))) });
      await page.screenshot({ path: path.join(output, `${scenario.name}-failure.png`) });
      throw error;
    }
    await page.evaluate(() => document.fonts.ready);
    const measure = id => page.getByTestId(id).evaluate(element => {
      const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    const body = await measure('persistent-session-character-seat');
    const line = await measure('persistent-session-baseline');
    const conversation = await measure('persistent-session-conversation');
    assert.ok(Math.abs(body.width - scenario.body) <= 1, `몸 폭 ${body.width}`);
    assert.ok(Math.abs(body.y + body.height - line.y) <= 1, '몸과 선의 접점');
    assert.equal(conversation.width, scenario.column);
    await page.screenshot({ path: path.join(output, `${scenario.name}-chat.png`) });
    const pas = page.getByTestId('persistent-session-screen');
    const input = pas.getByTestId('chat-composer-text-input');
    await input.fill('상세를 다녀온 뒤에도 남길 입력');
    await pas.getByTestId('chat-composer-attach-button').click();
    await pas.getByTestId('chat-attachment-remove-0').waitFor();
    await page.getByTestId('persistent-session-tasks').click();
    await page.getByTestId('card-row-public-persistent-412-summary').click();
    await page.getByTestId('card-read-summary-open').waitFor();
    const panel = await measure('persistent-session-card-panel');
    assert.equal(panel.width, scenario.detail);
    assert.deepEqual(await measure('persistent-session-conversation'), conversation, '카드 열림 후 중앙 열 불변');
    if (scenario.name === 'ipad-p-dark') assert.ok(panel.y + panel.height < line.y, '세로 상세가 선 위에서 끝남');
    await page.screenshot({ path: path.join(output, `${scenario.name}-card.png`) });
    await page.getByTestId('card-read-summary-open').click();
    await page.getByTestId('card-detail-frame').waitFor();
    await page.getByTestId('card-detail-frame').getByLabel('뒤로', { exact: true }).click();
    await page.getByTestId('card-read-summary-open').waitFor();
    await page.getByTestId('persistent-session-tasks').click();
    assert.equal(await input.inputValue(), '상세를 다녀온 뒤에도 남길 입력');
    await page.getByTestId('chat-attachment-remove-0').waitFor();
    const withAttachment = await measure('persistent-session-baseline');
    const attachedBody = await measure('persistent-session-character-seat');
    assert.ok(Math.abs(attachedBody.y + attachedBody.height - withAttachment.y) <= 1, '첨부 후 몸과 선 접점');
    await input.fill('첫 줄\n둘째 줄\n셋째 줄');
    const expanded = await measure('persistent-session-baseline');
    assert.ok(expanded.y < line.y, '여러 줄·첨부에서 선이 올라감');
    await page.screenshot({ path: path.join(output, `${scenario.name}-expanded.png`) });
    await page.getByTestId('persistent-session-character-toggle').click();
    await page.getByTestId('persistent-session-character-seat').waitFor({ state: 'hidden' });
    await page.getByTestId('persistent-session-character-toggle').waitFor();
    await page.getByTestId('persistent-session-settings').click();
    await page.getByText('표시와 모션', { exact: true }).click();
    await page.getByTestId('persistent-show-character').click();
    await page.screenshot({ path: path.join(output, `${scenario.name}-settings.png`) });
    await page.getByLabel('설정 닫기', { exact: true }).click();
    await page.getByTestId('persistent-session-character-seat').waitFor();
    result.viewports.push({ ...scenario, body, line, conversation, panel });
    result.interactions.push(`${scenario.name}: 실제 입구·카드 열기·같은 요약 복귀`);
    await context.close();
  }
  await runPhoneCaptures({ browser, base, prefix, output, result });
  await runEntryCaptures({ browser, base, prefix, output, result });
}

module.exports = { runPersistentFullscreenCaptures, runPhoneCaptures, runEntryCaptures, runSettingsCaptures, runHistoryCapture,
  fixturePage, swipe, selectPersistentHomeScenarios };

async function runHistoryCapture(env) {
  const { context, page } = await fixturePage(env, 'history', { width: 390, height: 844 }, 'sample=screen&history=long&safeArea=fixture');
  const pas = page.getByTestId('persistent-session-screen');
  await pas.getByText('공개 대화 40:', { exact: false }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000); // Finish the existing initial-history bottom-follow before reading older messages.
  const scroller = await pas.evaluateHandle(root => Array.from(root.querySelectorAll('div'))
    .filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]);
  const box = await scroller.evaluate(el => el.getBoundingClientRect().toJSON());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -140); // A real wheel gesture against the inverted list.
  await page.waitForTimeout(500);
  const before = await scroller.evaluate(el => el.scrollTop);
  const offsets = [];
  const readOffset = async label => offsets.push({ label, ...(await scroller.evaluate(el => ({ offset: el.scrollTop, height: el.clientHeight, content: el.scrollHeight }))) });
  await readOffset('before');
  assert.ok(before > 0, '최신 위치에서 벗어난 이력 표본');
  await page.getByTestId('phone-tab-PersistentTab').click();
  await readOffset('cards');
  await page.getByTestId('card-row-public-persistent-412-summary').click();
  await readOffset('summary');
  await page.getByTestId('card-read-summary-open').click();
  await readOffset('full-detail');
  await page.getByTestId('card-detail-frame').getByLabel('뒤로', { exact: true }).click();
  await page.getByTestId('card-read-summary-open').waitFor();
  await page.getByTestId('phone-tab-PersistentTab').click();
  await readOffset('conversation');
  const after = await scroller.evaluate(el => ({ connected: el.isConnected, offset: el.scrollTop }));
  env.result.viewports.push({ name: 'history', before, after, offsets });
  assert.ok(after.connected, '상세 왕복에서 같은 목록 DOM 유지');
  assert.ok(Math.abs(after.offset - before) <= 1, '읽던 위치 유지');
  await page.screenshot({ path: path.join(env.output, 'iphone-reading-position.png') });
  env.result.interactions.push('실제 FlatList의 과거 읽기 위치와 DOM을 카드 상세 왕복 뒤 유지');
  await context.close();
}

async function runSettingsCaptures(env) {
  for (const scenario of [
    { name: 'iphone-light', width: 390, height: 844, theme: 'light' },
    { name: 'iphone-dark', width: 390, height: 844, theme: 'dark' },
    { name: 'ipad-l-light', width: 1180, height: 820, theme: 'light' },
    { name: 'ipad-p-dark', width: 820, height: 1180, theme: 'dark' },
  ]) {
    const storyState = {
      'iphone-light': 'pas-story-long',
      'iphone-dark': 'pas-story-partial',
      'ipad-l-light': 'pas-story-empty',
      'ipad-p-dark': 'pas-story-error',
    }[scenario.name];
    const { context, page } = await fixturePage(env, scenario.name, { width: scenario.width, height: scenario.height },
      `sample=screen&theme=${scenario.theme}&safeArea=fixture&state=${storyState}`);
    const pas = page.getByTestId('persistent-session-screen');
    const input = pas.getByTestId('chat-composer-text-input');
    const draft = `스토리 설정 복귀 뒤에도 남길 초안 ${scenario.name}`;
    await input.fill(draft);
    await pas.getByTestId('chat-composer-attach-button').click();
    await pas.getByTestId('chat-attachment-remove-0').waitFor();
    await page.getByTestId('persistent-session-settings').click();
    await page.getByText('표시와 모션', { exact: true }).click();
    // AppModalSurface's existing fade must settle before comparing its surface.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(env.output, `${scenario.name}-settings.png`) });
    const surface = await page.getByTestId('persistent-session-pas-settings-surface').evaluate(element => ({
      background: getComputedStyle(element).backgroundColor, box: element.getBoundingClientRect().toJSON(),
    }));
    const storyTab = page.getByText('세션 스토리', { exact: true });
    const storyTabBox = await storyTab.boundingBox();
    assert.ok(storyTabBox, '세션 스토리 탭 터치 영역');
    await page.touchscreen.tap(storyTabBox.x + storyTabBox.width / 2, storyTabBox.y + storyTabBox.height / 2);
    await page.getByTestId('session-story-panel').waitFor();
    if (storyState === 'pas-story-long') {
      const scroll = page.getByTestId('persistent-session-pas-story-scroll');
      const before = await scroll.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
      assert.ok(before.content > before.height, '세션 스토리 설정 페이지가 콘텐츠를 스크롤함');
      await page.screenshot({ path: path.join(env.output, `${scenario.name}-story-settings.png`) });
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      const after = await scroll.evaluate(element => element.scrollTop);
      assert.ok(after > 0, '세션 스토리 설정 스크롤 위치가 이동함');
      await page.screenshot({ path: path.join(env.output, `${scenario.name}-story-settings-scrolled.png`) });
    } else if (storyState === 'pas-story-partial') {
      await page.getByText('요약만 남은 공개 예시 스토리입니다.', { exact: true }).waitFor();
    } else if (storyState === 'pas-story-empty') {
      await page.getByText('아직 정리된 스토리가 없습니다.', { exact: true }).waitFor();
    } else {
      const retry = page.getByTestId('session-story-retry');
      await retry.waitFor();
      await retry.click();
      await retry.waitFor();
    }
    if (storyState !== 'pas-story-long') await page.screenshot({ path: path.join(env.output, `${scenario.name}-story-settings.png`) });
    env.result.viewports.push({ ...scenario, surface });
    env.result.interactions.push(`${scenario.name}: PAS 설정 스토리 ${storyState}`);
    const close = page.getByLabel('설정 닫기', { exact: true });
    const closeBox = await close.boundingBox();
    assert.ok(closeBox, '설정 닫기 터치 영역');
    assert.ok(closeBox.y >= 0 && closeBox.y + closeBox.height <= scenario.height, '설정 닫기 버튼이 화면 안전 영역 안에 있음');
    await page.touchscreen.tap(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
    await page.getByTestId('persistent-session-screen').waitFor();
    assert.equal(await input.inputValue(), draft, '스토리 설정 왕복 뒤 대화 초안 유지');
    await pas.getByTestId('chat-attachment-remove-0').waitFor();
    await context.close();
  }
}

async function fixturePage({ browser, base, prefix, result }, name, viewport, query) {
  const context = await browser.newContext({ viewport, hasTouch: true, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push({ name, message: error.message }));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || new URL(url).origin === base) return route.continue();
    result.errors.push({ name, message: 'External request: ' + url });
    await route.abort();
  });
  await page.goto(`${base}${prefix}index.html?section=persistent&${query}`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
async function swipe(page, direction) {
  const frame = await page.getByTestId('persistent-session-screen').boundingBox();
  const left = frame.x + frame.width * 0.2;
  const right = frame.x + frame.width * 0.8;
  const y = frame.y + frame.height / 2;
  await page.mouse.move(direction === 'left' ? right : left, y);
  await page.mouse.down();
  await page.mouse.move(direction === 'left' ? left : right, y, { steps: 10 });
  await page.mouse.up();
}
async function runPhoneCaptures(env) {
  const { output, result } = env;
  for (const theme of ['light', 'dark']) {
    const name = `iphone-${theme}`;
    const { context, page } = await fixturePage(env, name, { width: 390, height: 844 }, `sample=screen&theme=${theme}&safeArea=fixture`);
    await page.getByTestId('persistent-session-screen').waitFor();
    assert.equal(await page.getByTestId('persistent-session-character-seat').count(), 0, 'phone 캐릭터 없음');
    const tabs = await page.getByTestId(/^phone-tab-/).evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-testid'), box: element.getBoundingClientRect().toJSON(), selected: element.getAttribute('aria-selected'), label: element.getAttribute('aria-label')
    })));
    assert.deepEqual(tabs.map(tab => tab.id), ['phone-tab-DailyTab', 'phone-tab-FolderTab', 'phone-tab-PersistentTab', 'phone-tab-FeedTab', 'phone-tab-SettingsTab']);
    assert.ok(Math.abs(tabs[2].box.x + tabs[2].box.width / 2 - 195) <= 1, '중앙 슬롯');
    const header = await page.getByTestId('persistent-session-header').boundingBox();
    const pas = page.getByTestId('persistent-session-screen');
    const input = pas.getByTestId('chat-composer-text-input');
    await input.fill('카드 상세에서도 보존할 초안');
    await pas.getByTestId('chat-composer-attach-button').click();
    await pas.getByTestId('chat-attachment-remove-0').waitFor();
    const composer = await pas.getByTestId('chat-composer-box').boundingBox();
    assert.ok(header.y >= 47, '상단 fixture 안전 영역');
    assert.ok(composer.y + composer.height <= tabs[2].box.y + 1, '탭 위 입력 접근');
    await page.screenshot({ path: path.join(output, `${name}-chat.png`) });
    await page.getByTestId('phone-tab-PersistentTab').click();
    await page.getByTestId('persistent-phone-tab-list').first().waitFor();
    await page.getByTestId('card-row-public-persistent-412-summary').click();
    await page.getByTestId('card-read-summary-open').waitFor();
    await page.screenshot({ path: path.join(output, `${name}-card.png`) });
    await page.getByTestId('card-read-summary-open').click();
    await page.getByTestId('card-detail-frame').waitFor();
    await page.getByTestId('settings-segment-card-detail-sessions').click();
    await page.getByTestId('card-sessions').waitFor();
    await page.getByTestId('card-detail-frame').getByLabel('뒤로', { exact: true }).click();
    await page.getByTestId('card-read-summary-open').waitFor();
    await swipe(page, 'right');
    await page.getByTestId('card-row-public-persistent-412-summary').waitFor();
    await swipe(page, 'right');
    await page.getByTestId('persistent-session-conversation').getByTestId('chat-composer-text-input').waitFor();
    assert.equal(await input.inputValue(), '카드 상세에서도 보존할 초안');
    await page.getByTestId('chat-attachment-remove-0').waitFor();
    await swipe(page, 'left');
    await page.getByTestId('persistent-phone-tab-list').first().waitFor();
    await page.getByTestId('phone-tab-PersistentTab').click();
    await input.waitFor();
    await page.getByTestId('persistent-session-settings').click();
    await page.getByText('표시와 모션', { exact: true }).click();
    await page.getByTestId('persistent-show-character').waitFor();
    await page.screenshot({ path: path.join(output, `${name}-settings.png`) });
    await page.getByLabel('설정 닫기', { exact: true }).click();
    assert.equal(await input.inputValue(), '카드 상세에서도 보존할 초안');
    await page.getByTestId('phone-tab-DailyTab').click();
    await page.getByTestId('phone-tab-DailyTab').waitFor();
    await page.getByTestId('phone-tab-PersistentTab').click();
    await input.waitFor();
    assert.equal(await page.getByTestId('persistent-phone-tab-list').count(), 0, '다른 탭 입구는 대화로 복귀');
    result.viewports.push({ name, tabs, header, composer });
    result.interactions.push(`${name}: 중앙 슬롯·좌우 밀기·상세→목록→대화·동일 초안/첨부·설정 복귀·하단 탭 이동`);
    await context.close();
  }
}
async function runEntryCaptures(env) {
  const { output, result } = env;
  if (env.persistentHome) {
    const selected = selectPersistentHomeScenarios(env.persistentHomeScenario);
    for (const scenario of selected) await runPersistentHomeScenario(env, scenario);
    return;
  }
  for (const scenario of [
    { name: 'entry-zero', query: 'sample=entry&count=0', manual: true, expected: 'settings-section-persistent-editor-groups' },
    { name: 'entry-one', query: 'sample=entry&count=1', manual: true, expected: 'persistent-session-screen' },
    { name: 'entry-two-dark', query: 'sample=entry&count=2&theme=dark', manual: true, expected: 'persistent-entry-review-pas-2' },
    { name: 'entry-error', query: 'sample=entry&state=persistent-error', manual: true, expected: 'persistent-entry-error' },
    { name: 'entry-loading', query: 'sample=entry&state=entry-loading', manual: true, expected: 'persistent-entry-loading' },
    { name: 'startup-zero', query: 'sample=startup&startup=1&count=0', expected: 'phone-tab-DailyTab' },
    { name: 'startup-last', query: 'sample=startup&startup=1&count=2&last=review-pas-2', expected: 'persistent-session-screen' },
    { name: 'startup-choose', query: 'sample=startup&startup=1&count=2', expected: 'persistent-entry-review-pas-1' },
    { name: 'safe-zero', query: 'sample=screen&count=1', expected: 'persistent-session-screen' },
    { name: 'ipad-low-height', query: 'sample=screen&count=1&safeArea=fixture', expected: 'persistent-session-screen', viewport: { width: 1180, height: 480 } },
  ]) {
    const { context, page } = await fixturePage(env, scenario.name, scenario.viewport ?? { width: 390, height: 844 }, scenario.query + '&safeArea=' + (scenario.name === 'safe-zero' ? 'zero' : 'fixture'));
    if (scenario.manual) await page.getByTestId('phone-tab-PersistentTab').click();
    await page.getByTestId(scenario.expected).first().waitFor();
    await page.waitForTimeout(400); // Existing sheet slide/fade presentation.
    if (scenario.name === 'entry-two-dark') {
      await page.screenshot({ path: path.join(output, `${scenario.name}.png`) });
      await page.getByTestId('persistent-entry-review-pas-2').click();
      await page.getByText('공개 예시 두 번째 영구 세션', { exact: true }).waitFor();
    } else await page.screenshot({ path: path.join(output, `${scenario.name}.png`) });
    if (scenario.name === 'ipad-low-height') {
      assert.equal(await page.getByTestId('persistent-session-character-seat').count(), 0);
      assert.equal(await page.getByTestId('persistent-session-character-toggle').count(), 0);
    }
    result.interactions.push(scenario.name);
    await context.close();
  }
}

function selectPersistentHomeScenarios(name) {
  const scenarios = [
    { name: 'ipad-landscape-light', role: 'tablet', viewport: { width: 1180, height: 820 }, theme: 'light' },
    { name: 'ipad-portrait-dark', role: 'tablet', viewport: { width: 820, height: 1180 }, theme: 'dark' },
    { name: 'iphone-light', role: 'phone', viewport: { width: 390, height: 844 }, theme: 'light' },
    { name: 'ipad-narrow-dark', role: 'phone', viewport: { width: 600, height: 900 }, theme: 'dark' },
  ];
  const selected = name ? scenarios.filter(scenario => scenario.name === name) : scenarios;
  assert.ok(selected.length > 0, `persistent-home 시나리오를 찾을 수 없습니다: ${name}`);
  return selected;
}

async function runPersistentHomeScenario(env, scenario) {
  const { context, page } = await fixturePage(env, scenario.name, scenario.viewport,
    `sample=entry&count=1&safeArea=fixture&theme=${scenario.theme}`);
  const shot = part => page.screenshot({ path: path.join(env.output, `${scenario.name}-${part}.png`) });
  const touch = async testID => {
    const target = page.getByTestId(testID);
    await target.waitFor({ state: 'visible' });
    const box = await target.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `${testID} 터치 영역`);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  const measure = async testID => page.getByTestId(testID).evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
  });
  const measurePas = async () => ({
    screen: await measure('persistent-session-screen'),
    header: await measure('persistent-session-header'),
    conversation: await measure('persistent-session-conversation'),
    composer: await measure('chat-composer-text-input'),
  });
  const assertSameFrame = (before, after, name) => {
    for (const part of ['screen', 'header', 'conversation', 'composer']) {
      for (const edge of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(before[part][edge] - after[part][edge]) <= 1,
          `${name} 재진입 ${part}.${edge}: ${before[part][edge]} → ${after[part][edge]}`);
      }
    }
  };

  try {
    const phoneTabs = page.getByTestId(/^phone-tab-/);
    const safeArea = scenario.role === 'tablet' ? { top: 24, bottom: 20 } : { top: 47, bottom: 34 };
    if (scenario.role === 'tablet') {
      const entry = page.getByTestId('tablet-persistent-entry');
      await entry.waitFor({ state: 'visible' });
      assert.equal(await phoneTabs.count(), 0, 'tablet 탐색에는 phone 탭이 없음');
      await shot('main-entry');
      await touch('tablet-persistent-entry');

      const pas = page.getByTestId('persistent-session-screen');
      await pas.waitFor({ state: 'visible' });
      await page.getByTestId('persistent-session-header').getByText('로젤린', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('persistent-session-home').count(), 1, 'tablet PAS Home 표시');
      assert.equal(await phoneTabs.count(), 0, 'tablet PAS에 phone 탭 없음');
      const actionIds = ['persistent-session-home', 'persistent-session-appearance', 'persistent-session-settings'];
      const actionBoxes = [];
      const actionSurfaces = [];
      for (const id of actionIds) {
        const box = await page.getByTestId(id).boundingBox();
        assert.ok(box, `${id} 버튼 프레임`);
        actionBoxes.push({ x: box.x, y: box.y, width: box.width, height: box.height, right: box.x + box.width });
        actionSurfaces.push(await page.getByTestId(`${id}-visual`).evaluate(element => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height, borderRadius: style.borderRadius,
            borderWidth: style.borderWidth, backgroundColor: style.backgroundColor };
        }));
      }
      for (let index = 1; index < actionBoxes.length; index += 1) {
        assert.ok(Math.abs(actionBoxes[index].height - actionBoxes[0].height) <= 1, '헤더 액션 높이 일치');
        assert.ok(Math.abs(actionBoxes[index].y - actionBoxes[0].y) <= 1, '헤더 액션 기준선 일치');
        assert.deepEqual(actionSurfaces[index], actionSurfaces[0], '헤더 액션의 기존 원형 표면 계약');
      }
      const gaps = [actionBoxes[1].x - actionBoxes[0].right, actionBoxes[2].x - actionBoxes[1].right];
      assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1, 'Home·밝기·설정 간격 일치');
      const beforeHome = await measurePas();
      assert.ok(beforeHome.header.y >= safeArea.top, 'tablet 헤더가 비영 상단 안전 영역 아래에 있음');
      assert.ok(beforeHome.composer.bottom <= scenario.viewport.height - safeArea.bottom + 1,
        'tablet 입력이 비영 하단 안전 영역 위에 있음');
      await shot('pas');

      await touch('persistent-session-home');
      await pas.waitFor({ state: 'hidden' });
      await page.getByTestId('tablet-persistent-entry').waitFor({ state: 'visible' });
      await shot('home-return');
      await touch('tablet-persistent-entry');
      await pas.waitFor({ state: 'visible' });
      await page.getByTestId('persistent-session-header').getByText('로젤린', { exact: true }).waitFor();
      const afterHome = await measurePas();
      assertSameFrame(beforeHome, afterHome, scenario.name);
      await shot('reentry');
      result.viewports.push({ ...scenario, safeArea, beforeHome, afterHome, actionBoxes, actionSurfaces, gaps });
      result.interactions.push(`${scenario.name}: Main 입구 터치 → PAS Home → Main 복귀 → 같은 입구 재진입`);
    } else {
      await page.getByTestId('phone-tab-DailyTab').waitFor({ state: 'visible' });
      const tabs = await phoneTabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')));
      assert.deepEqual(tabs, ['phone-tab-DailyTab', 'phone-tab-FolderTab', 'phone-tab-PersistentTab', 'phone-tab-FeedTab', 'phone-tab-SettingsTab']);
      await shot('daily-entry');
      await touch('phone-tab-PersistentTab');

      const pas = page.getByTestId('persistent-session-screen');
      await pas.waitFor({ state: 'visible' });
      await page.getByTestId('persistent-session-header').getByText('로젤린', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('persistent-session-home').count(), 0, 'phone PAS 상단 Home 없음');
      const beforeHome = await measurePas();
      assert.ok(beforeHome.header.y >= safeArea.top, 'phone 헤더가 비영 상단 안전 영역 아래에 있음');
      assert.ok(beforeHome.composer.bottom <= scenario.viewport.height - safeArea.bottom + 1,
        'phone 입력이 비영 하단 안전 영역 위에 있음');
      await shot('pas');

      await touch('phone-tab-DailyTab');
      await page.getByTestId('phone-tab-DailyTab').waitFor({ state: 'visible' });
      await pas.waitFor({ state: 'hidden' });
      await shot('daily-return');
      await touch('phone-tab-PersistentTab');
      await pas.waitFor({ state: 'visible' });
      await page.getByTestId('persistent-session-header').getByText('로젤린', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('persistent-session-home').count(), 0, 'phone PAS 재진입에도 상단 Home 없음');
      const afterHome = await measurePas();
      assertSameFrame(beforeHome, afterHome, scenario.name);
      await shot('reentry');
      result.viewports.push({ ...scenario, safeArea, beforeHome, afterHome, tabs });
      result.interactions.push(`${scenario.name}: PersistentTab → DailyTab → PersistentTab 왕복, 상단 Home 없음`);
    }
  } finally {
    await context.close();
  }
}
