import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installV3VisualQaRoutes } from './v3-visual-fixtures';
import { installChatUiRoutes, openChatUi } from './chat-ui-fixtures';

const output = path.resolve('../.local/artifacts/card1964-display');
mkdirSync(output, { recursive: true });
for (const width of [1440, 360]) for (const theme of ['light', 'dark'] as const) {
  test(`display review ${width} ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(value => { localStorage.setItem('soul-dashboard-theme', value); localStorage.setItem('ls.webglGlass', '0'); localStorage.setItem('soul-language', 'ko'); }, theme);
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: '기존 채팅' });
    await page.route('**/api/auth/config', route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, user: { email: 'qa@example.test', name: 'QA', isAdmin: true } } }));
    await page.goto('/components');
    const review = page.getByTestId('chat-ui-review-manuscript');
    const choose = async (label: string) => { await review.getByRole('button', { name: label, exact: true }).click(); };
    const capture = async (name: string) => { await page.evaluate(() => document.fonts.ready); await review.locator('[data-slot="chat-message-row"]').filter({ has: page.locator('.chat-ui') }).last().screenshot({ path: path.join(output, `answer-${name}-${width}-${theme}.png`), animations: 'disabled' }); };
    await choose('카드 현황');
    const title = review.locator('.chat-ui-list-title').first();
    await expect(title).toBeVisible();
    const titleStyle = await title.evaluate(el => ({ clamp: getComputedStyle(el).webkitLineClamp, width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }));
    expect(titleStyle.clamp).toBe('2'); expect(titleStyle.width).toBeGreaterThan(80); expect(titleStyle.scroll).toBeLessThanOrEqual(titleStyle.client + 1);
    const cardLink = review.locator('.chat-ui-list-row[href]').first();
    await cardLink.focus(); await page.keyboard.press('Tab'); await expect(page.locator(':focus')).toBeVisible();
    await capture('cards');
    await choose('노드 자원');
    const stats = review.locator('.chat-ui-stat'); await expect(stats).toHaveCount(4);
    const statRects = await stats.evaluateAll(els => els.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, width: el.getBoundingClientRect().width })));
    if (width === 360) { expect(statRects[0].y).toBe(statRects[1].y); expect(statRects[2].y).toBeGreaterThan(statRects[0].y); }
    await capture('resources');
    if (width === 1440) {
      const container = review.locator('[data-chat-ui-node="stats"] .chat-ui-display-container');
      const grid = container.locator('.chat-ui-stats');
      const positions = () => stats.evaluateAll(els => els.map(el => el.getBoundingClientRect().y));
      await container.evaluate(el => { el.style.width = '452px'; });
      expect(new Set(await positions()).size).toBe(1);
      await container.evaluate(el => { el.style.width = '451px'; });
      expect(new Set(await positions()).size).toBe(2);
      await grid.evaluate(el => { el.classList.replace('chat-ui-stats-4', 'chat-ui-stats-3'); });
      await container.evaluate(el => { el.style.width = '340px'; });
      expect(new Set((await positions()).slice(0, 3)).size).toBe(1);
      await container.evaluate(el => { el.style.width = '339px'; });
      expect(new Set((await positions()).slice(0, 3)).size).toBe(3);
      await grid.evaluate(el => { el.classList.replace('chat-ui-stats-3', 'chat-ui-stats-4'); });
      await container.evaluate(el => { el.style.width = ''; });
    }
    await choose('배포'); await expect(review.locator('.chat-ui-step')).toHaveCount(4); await capture('deploy');
    await choose('조사 요약');
    let table = review.locator('.chat-ui-table-frame'); await expect(table.locator('tbody tr')).toHaveCount(3);
    await capture('research');
    await choose('긴 표'); table = review.locator('.chat-ui-table-frame'); await expect(table.locator('tbody tr')).toHaveCount(50);
    const headerBefore = await table.locator('thead th').first().boundingBox();
    await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const headerAfter = await table.locator('thead th').first().boundingBox();
    expect(Math.abs(headerBefore!.y - headerAfter!.y)).toBeLessThanOrEqual(1);
    expect(await table.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await table.evaluate(el => { el.scrollTop = 0; });
    const before = await table.locator('tbody td').first().boundingBox();
    await table.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const after = await table.locator('tbody td').first().boundingBox();
    expect(Math.abs(before!.x - after!.x)).toBeLessThanOrEqual(1);
    const extent = await table.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, left: el.scrollLeft }));
    expect(extent.scroll).toBeGreaterThan(extent.client); expect(extent.left).toBeGreaterThan(0);
    const columns = await review.locator('.chat-ui-compare-column').evaluateAll(els => els.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })));
    if (width === 360) expect(columns[1].y).toBeGreaterThan(columns[0].y);
    if (width === 1440) {
      const container = review.locator('[data-chat-ui-node="compare"] .chat-ui-display-container');
      const positions = () => review.locator('.chat-ui-compare-column').evaluateAll(els => els.map(el => el.getBoundingClientRect().y));
      await container.evaluate(el => { el.style.width = '440px'; });
      expect(new Set(await positions()).size).toBe(1);
      await container.evaluate(el => { el.style.width = '439px'; });
      expect(new Set(await positions()).size).toBe(2);
      await container.evaluate(el => { el.style.width = ''; });
    }
    await table.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    await choose('흐름'); const flow = review.locator('.chat-ui-flow:visible');
    await expect(flow.locator('.chat-ui-flow-node')).toHaveCount(12);
    await expect(flow).toHaveAttribute('data-transposed', width === 360 ? 'true' : 'false');
    await expect(review.locator('.chat-ui-flow').nth(width === 360 ? 0 : 1)).toBeHidden();
    if (width === 1440) {
      const container = review.locator('.chat-ui-flow-container');
      await container.evaluate(el => { el.style.width = '440px'; });
      await expect(review.locator('.chat-ui-flow:visible')).toHaveAttribute('data-transposed', 'false');
      await container.evaluate(el => { el.style.width = '439px'; });
      await expect(review.locator('.chat-ui-flow:visible')).toHaveAttribute('data-transposed', 'true');
      await container.evaluate(el => { el.style.width = ''; });
    }
    await capture('flow');
    await choose('그림과 HTML'); const frame = review.locator('iframe');
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(frame).toHaveAttribute('srcdoc', /default-src 'none'/);
    await expect(frame).toHaveAttribute('srcdoc', new RegExp(`color-scheme:${theme}`));
    const image = review.locator('[data-chat-ui-node="image"] [role="button"]').first(); await image.focus(); await image.press('Enter');
    const viewer = page.getByRole('dialog'); await expect(viewer).toBeVisible(); await expect(viewer).toBeFocused();
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0); await expect(image).toBeFocused();
    await capture('media');
    const input = review.locator('textarea[data-slot="chat-input-body"]'); await input.fill('유지할 초안');
    const scroll = page.locator('main.v3-components-main');
    const scrollBefore = await scroll.evaluate(el => el.scrollTop);
    await page.setViewportSize({ width: width === 360 ? 1440 : 360, height: 1000 }); await expect(input).toHaveValue('유지할 초안');
    const scrollAfter = await scroll.evaluate(el => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0); expect(scrollAfter).toBeGreaterThan(0);
    writeFileSync(path.join(output, `measure-${width}-${theme}.json`), JSON.stringify({ titleStyle, statRects, table: { before, after, extent, headerBefore, headerAfter }, columns, overflow, scrollBefore, scrollAfter }, null, 2));
  });
}

test('actual chat retains its draft, composer and reading position while resizing', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installChatUiRoutes(page, { example: 'displayResearch', count: 40 });
  const root = await openChatUi(page, true);
  const input = root.locator('textarea[data-slot="chat-input-body"]');
  const scroller = root.locator('[data-virtuoso-scroller="true"]');
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await input.fill('크기 변경 중인 초안');
  await expect(input).toBeInViewport();
  const bottomGap = () => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(bottomGap).toBeLessThanOrEqual(5);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(input).toHaveValue('크기 변경 중인 초안');
    await expect(input).toBeInViewport();
    await expect.poll(bottomGap).toBeLessThanOrEqual(5);
  }
});
