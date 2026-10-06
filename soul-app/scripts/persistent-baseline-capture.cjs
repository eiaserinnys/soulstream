const assert = require('node:assert/strict');
const path = require('node:path');

// The same public fixtures and actual production entry trees in both bundles.
async function runPersistentBaselineCaptures({ browser, base, prefix, output, result }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push({ name: 'baseline', message: error.message }));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || new URL(url).origin === base) return route.continue();
    result.errors.push({ name: 'baseline', message: 'External request: ' + url });
    await route.abort();
  });
  const open = async (query, id) => {
    await page.goto(`${base}${prefix}index.html?theme=light&${query}`);
    await page.getByTestId(id).waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const shot = async name => page.screenshot({ path: path.join(output, name + '.png') });
  await open('section=rows', 'card-row-public-todo-layout');
  await shot('ordinary-rows');
  await open('section=cardHome', 'review-card-home');
  await page.getByTestId('postit-open-public-review').click();
  await page.getByTestId('card-detail-container').waitFor();
  await shot('ordinary-card-detail');
  await open('section=nativeSettings', 'settings-modal-header');
  await shot('ordinary-settings');
  await open('section=entryShell', 'card-home-screen');
  await shot('ordinary-home');
  const tabs = page.getByRole('tab');
  const tabOrder = await tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')));
  await tabs.nth(tabOrder.includes('phone-tab-FeedTab') ? 3 : 2).click();
  await page.getByTestId('session-card-public-shell-session-0').click();
  await page.getByLabel('이전 패널로 돌아가기', { exact: true }).waitFor();
  await shot('ordinary-chat');
  await page.getByLabel('이전 패널로 돌아가기', { exact: true }).click();
  await page.getByTestId('phone-feed-body').waitFor();
  assert.equal(await page.getByLabel('이전 패널로 돌아가기', { exact: true }).count(), 0);
  result.interactions.push('기본 행·일반 카드 상세·설정·실제 홈·피드→ChatScreen→피드 복귀');
  await context.close();
}
module.exports = { runPersistentBaselineCaptures };
