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
    await page.getByTestId('persistent-session-home').click();
    await page.getByTestId('tablet-persistent-entry').waitFor();
    result.viewports.push({ ...scenario, body, line, conversation, panel });
    result.interactions.push(`${scenario.name}: 실제 입구·카드 열기·같은 요약 복귀·홈 pop`);
    await context.close();
  }
}
module.exports = { runPersistentFullscreenCaptures };
