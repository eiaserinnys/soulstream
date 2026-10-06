const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

// The same public fixtures and actual production entry trees in both bundles.
async function runPersistentBaselineCaptures({ browser, base, prefix, root, output, result }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push({ name: 'baseline', message: error.message }));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('data:') || new URL(url).origin === base) return route.continue();
    if (url.startsWith('https://public-fixture.invalid/api/nodes/') && url.endsWith('/portrait')) {
      // Both comparison bundles use the same bundled public portrait fixture.
      const asset = path.join(root, 'assets/_assets/icon.cd4da98f94571d857faff2bf18a78353.png');
      return route.fulfill({ status: 200, contentType: 'image/png', body: await fs.readFile(asset) });
    }
    result.errors.push({ name: 'baseline', message: 'External request: ' + url });
    await route.abort();
  });
  const open = async (query, id) => {
    await page.goto(`${base}${prefix}index.html?theme=light&${query}`);
    await page.getByTestId(id).waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const shot = async name => {
    await page.waitForTimeout(400); // Existing stack/modal animations in both bundles.
    await page.screenshot({ path: path.join(output, name + '.png') });
  };
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
  const feedIndex = tabOrder.includes('phone-tab-FeedTab') ? 3 : 2;
  await tabs.nth(feedIndex).click();
  await page.getByTestId('session-card-pressable').first().click();
  await page.getByLabel('이전 패널로 돌아가기', { exact: true }).waitFor();
  await shot('ordinary-chat');
  await page.getByLabel('이전 패널로 돌아가기', { exact: true }).click();
  await page.getByTestId('phone-feed-body').waitFor();
  assert.equal(await tabs.nth(feedIndex).getAttribute('aria-selected'), 'true');
  result.interactions.push('기본 행·일반 카드 상세·설정·실제 홈·피드→ChatScreen→피드 복귀');
  await context.close();
}
module.exports = { runPersistentBaselineCaptures };
