import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const output = path.resolve('../../../.local/artifacts/20261002-completed-card-browser');
const baseline = process.env.COMPLETED_FILTER_BASELINE === '1';
const periods = ['7', '30', 'all', 'custom'];
async function open(page: Page, section: string) {
  await page.addInitScript(() => localStorage.setItem('ls.webglGlass', '0'));
  await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, user: { email: 'completed@example.test' } } }));
  await page.goto(`/assets/ios-components/?section=${section}`);
}
async function capture(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${baseline ? 'before' : 'after'}-rn-filter-${name}.png`), animations: 'disabled' });
}
async function labels(scope: Locator) {
  return Promise.all(periods.map(value => scope.getByTestId(`settings-segment-completed-period-${value}-visual`).evaluate(node => {
    const label = node.firstElementChild!, rect = label.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(label);
    const style = getComputedStyle(label);
    return { text: label.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      lines: range.getClientRects().length, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth,
      fontSize: style.fontSize, lineHeight: style.lineHeight };
  })));
}
for (const width of [390, 744, 1210]) test(`completed period whole-button wrap board and expansion ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await open(page, 'boardConnected');
  const workspace = page.getByTestId('card-board-workspace');
  await expect(workspace).toBeVisible();
  await workspace.getByLabel('완료 숨김').click();
  await workspace.getByTestId('card-board').evaluate(node => { node.scrollLeft = node.scrollWidth; });
  const main = await labels(workspace);
  if (!baseline) for (const label of main) { expect(label.lines).toBe(1); expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1); }
  // Natural-width labels can all fit at the phone typography size; do not force a row break.
  if (!baseline) for (let index = 1; index < main.length; index++) {
    const previous = main[index - 1], current = main[index];
    if (current.y === previous.y) expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width);
    else expect(current.y).toBeGreaterThan(previous.y);
  }
  await capture(page, `board-${width}`);
  let expanded: Awaited<ReturnType<typeof labels>> | undefined;
  if (width >= 700) {
    await workspace.getByLabel('보드 확대', { exact: true }).click();
    const overlay = page.getByTestId('card-board-expanded');
    await expect(overlay).toBeVisible();
    await overlay.getByTestId('card-board').evaluate(node => { node.scrollLeft = node.scrollWidth; });
    expanded = await labels(overlay);
    if (!baseline) for (const label of expanded) { expect(label.lines).toBe(1); expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1); }
    await capture(page, `expanded-${width}`);
  }
  writeFileSync(path.join(output, `${baseline ? 'before' : 'after'}-rn-filter-layout-${width}.json`), JSON.stringify({ main, expanded, platform: 'RN web; native unmeasured' }, null, 2));
});
for (const width of [390, 1210]) test(`existing settings default stays unchanged ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await open(page, 'settings');
  const first = page.getByTestId('settings-segment-appearance-system');
  await first.scrollIntoViewIfNeeded();
  await expect(first).toBeVisible();
  const geometry = await Promise.all(['system', 'light', 'dark'].map(value => page.getByTestId(`settings-segment-appearance-${value}`).evaluate(node => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: getComputedStyle(node.querySelector('[dir]')!).fontSize };
  })));
  expect(new Set(geometry.map(rect => rect.y)).size).toBe(1);
  expect(Math.max(...geometry.map(rect => rect.width)) - Math.min(...geometry.map(rect => rect.width))).toBeLessThanOrEqual(1);
  await capture(page, `settings-${width}`);
  if (!baseline) {
    const { readFileSync } = await import('node:fs');
    expect(geometry).toEqual(JSON.parse(readFileSync(path.join(output, `before-rn-filter-settings-${width}.json`), 'utf8')));
  }
  writeFileSync(path.join(output, `${baseline ? 'before' : 'after'}-rn-filter-settings-${width}.json`), JSON.stringify(geometry, null, 2));
});
