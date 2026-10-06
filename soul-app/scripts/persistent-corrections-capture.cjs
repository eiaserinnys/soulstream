const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fixturePage } = require('./persistent-fullscreen-capture.cjs');
const box = locator => locator.evaluate(el => {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
const right = rect => rect.x + rect.width;
async function circle(locator) {
  return locator.evaluate(root => {
    const el = [root, ...root.querySelectorAll('div')].find(el => {
      const css = getComputedStyle(el), b = el.getBoundingClientRect();
      return b.width === b.height && b.width > 0 && parseFloat(css.borderRadius) > 0 && parseFloat(css.borderTopWidth) > 0;
    });
    if (!el) throw new Error('원형 표면 없음');
    const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}
const shot = (env, page, name) => page.screenshot({ path: path.join(env.output, name + '.png') });

async function runCorrectionCaptures(env) {
  for (const [width, height] of [[1180, 820], [1194, 834], [820, 1180], [834, 1194], [390, 844]]) {
    const name = `${width}x${height}`;
    const { context, page } = await fixturePage(env, name, { width, height }, 'sample=screen&safeArea=fixture&theme=light');
    const record = { name };
    env.result.viewports.push(record);
    await page.getByTestId('persistent-session-screen').waitFor();
    await page.getByTestId('persistent-session-tasks').click();
    const row = page.getByTestId('card-row-public-persistent-412-summary');
    await row.waitFor();
    record.list = await box(page.getByTestId('persistent-session-card-panel'));
    record.row = await box(row);
    record.avatar = await box(page.getByTestId('card-public-persistent-412-avatar'));
    record.button = await circle(page.getByTestId('persistent-session-tasks'));
    assert.ok(Math.abs(right(record.avatar) - right(record.button)) <= 1, 'C2 초상과 작업 원 오른쪽 선');
    assert.ok(Math.abs(right(record.row) - right(record.avatar) - 8) <= 1, 'C2 눌림 번짐');
    await shot(env, page, name + '-list');
    await row.click();
    await page.getByTestId('card-read-summary-open').waitFor();
    record.summary = await box(page.getByTestId('persistent-session-card-panel'));
    record.column = await box(page.getByTestId('persistent-session-conversation'));
    if (width > height) assert.equal(record.summary.x - right(record.column), 24, 'C2 요약 위치 불변');
    record.back = await circle(page.getByTestId('persistent-summary-back'));
    record.title = await box(page.getByTestId('card-read-summary-title'));
    record.request = await page.getByTestId('card-read-summary-request').evaluate(root => {
      const el = Array.from(root.querySelectorAll('div')).find(el => el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE);
      return el.getBoundingClientRect().x;
    });
    assert.ok(Math.abs(record.back.x - record.title.x) <= 1, 'C4 원과 내용 시작선');
    assert.ok(Math.abs(record.back.x - record.request) <= 1, 'C4 원과 요청 라벨 시작선');
    await shot(env, page, name + '-summary');
    await page.getByTestId('persistent-summary-back').click();
    await row.waitFor();
    record.listAfter = await box(page.getByTestId('persistent-session-card-panel'));
    assert.deepEqual(record.listAfter, record.list, 'C2 목록 복귀 좌표');
    await context.close();
  }
  for (const viewport of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
    for (const runtime of ['all', 'none', 'tasks']) {
      const name = `line-${viewport.width}-${runtime}`;
      const query = runtime === 'all' ? '' : `&runtime=${runtime}`;
      const { context, page } = await fixturePage(env, name, viewport, 'sample=screen&safeArea=fixture&theme=light' + query);
      await page.getByTestId('persistent-session-baseline').waitFor();
      if (runtime === 'tasks') {
        await page.getByTestId('runtime-tasks-strip').waitFor();
        await page.getByTestId('runtime-tasks-header-touch').click();
        await page.getByTestId('runtime-tasks-details-scroll').waitFor();
        await page.getByTestId('runtime-tasks-header-touch').click();
        await page.getByTestId('runtime-tasks-details-scroll').waitFor({ state: 'hidden' });
      }
      await page.waitForTimeout(200);
      const line = await box(page.getByTestId('persistent-session-baseline'));
      const column = await box(page.getByTestId('persistent-session-conversation'));
      const strips = await page.getByTestId(/^runtime-(tasks|schedules|signals)-strip$/).evaluateAll(els => els.map(el => ({
        id: el.dataset.testid, border: parseFloat(getComputedStyle(el).borderBottomWidth), rect: el.getBoundingClientRect().toJSON(),
      })));
      assert.equal(strips.length, runtime === 'all' ? 2 : runtime === 'none' ? 0 : 1);
      if (strips.length) assert.equal(strips.at(-1).border, 0, 'C3 마지막 보조 줄 아래 선 없음');
      for (const strip of strips.slice(0, -1)) assert.equal(strip.border, line.height, 'C3 줄 사이 한 겹');
      const color = await page.getByTestId('persistent-session-baseline').evaluate(el => getComputedStyle(el).backgroundColor);
      const record = { name, line, column, color, strips };
      env.result.viewports.push(record);
      await shot(env, page, name);
      await page.screenshot({ path: path.join(env.output, name + '-seam.png'), clip: { x: line.x, y: line.y - 4, width: line.width, height: 9 } });
      const underline = await page.getByTestId('persistent-session-screen').getByTestId('chat-composer-box').evaluate(el => ({
        border: parseFloat(getComputedStyle(el).borderBottomWidth), color: getComputedStyle(el).borderBottomColor,
      }));
      record.underline = underline;
      await context.close();
    }
  }
  env.result.interactions.push('C2 네 iPad 목록/요약/목록 왕복, C4 phone/iPad 시작선, C3 실제 보조 줄 0/1/2와 접힘 경계');
}

async function runDefaultChatCapture(env) {
  const context = await env.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'review', value: 'fixture', url: env.base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => env.result.errors.push({ name: 'default-chat', message: error.message }));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || new URL(url).origin === env.base) return route.continue();
    env.result.errors.push({ name: 'default-chat', message: 'External request: ' + url });
    await route.abort();
  });
  await page.route('https://public-fixture.invalid/api/nodes/**/portrait', async route => route.fulfill({
    status: 200, contentType: 'image/png', body: await fs.readFile(path.join(env.root, 'assets/_assets/icon.cd4da98f94571d857faff2bf18a78353.png')),
  }));
  await page.goto(`${env.base}${env.prefix}index.html?section=entryShell&theme=light`);
  await page.getByTestId('card-home-screen').waitFor();
  const tabs = page.getByRole('tab');
  const tabOrder = await tabs.evaluateAll(elements => elements.map(el => el.getAttribute('data-testid')));
  await tabs.nth(tabOrder.includes('phone-tab-FeedTab') ? 3 : 2).click();
  await page.getByTestId('session-card-pressable').first().click();
  await page.getByLabel('이전 패널로 돌아가기', { exact: true }).waitFor();
  // RN SSE의 초기 연결 타이머 전에 빈 대화를 찍지 않는다. 동일 공개 메시지를 기다린다.
  await page.getByText('이 카드의 담당 대화를 오른쪽에서 보여주세요.', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await shot(env, page, 'ordinary-chat');
  await context.close();
  env.result.interactions.push('기본 ChatScreen: 같은 공개 SSE 메시지가 표시된 뒤 캡처');
}
module.exports = { runCorrectionCaptures, runDefaultChatCapture };
