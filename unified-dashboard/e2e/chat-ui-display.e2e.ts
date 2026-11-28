import { expect, test, type Locator, type Page } from '@playwright/test';
import { renderText, validateChatUiDocument } from '@soulstream/chat-ui';
import { displayDocuments, displayMediaDocument } from './chat-ui-display-documents';
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
    expect(await table.evaluate(el => el.scrollTop)).toBe(0);
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
    await checkFlow(flow, 11);
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

type Theme = 'light' | 'dark';
type Pixel = [number, number, number];

async function pixels(page: Page, png: Buffer, samples: { x: number; y: number }[], palette = false): Promise<Pixel[]> {
  return page.evaluate(async ({ source, samples, palette }) => {
    const image = await createImageBitmap(await (await fetch(source)).blob());
    const context = document.createElement('canvas').getContext('2d')!;
    context.canvas.width = image.width;
    context.canvas.height = image.height;
    context.drawImage(image, 0, 0);
    if (!palette) return samples.map(({ x, y }) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)) as Pixel);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
    return [...colors].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1])
      .map(([rgb]) => [rgb >> 16, (rgb >> 8) & 255, rgb & 255]);
  }, { source: 'data:image/png;base64,' + png.toString('base64'), samples, palette });
}

function contrast(a: Pixel, b: Pixel) {
  const luminance = (rgb: Pixel) => rgb.map(channel => channel / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
    .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

async function checkTextContrast(page: Page, text: Locator, minimum: number) {
  const [background, ...ink] = await pixels(page, await text.screenshot({ scale: 'device' }), [], true);
  expect(Math.max(...ink.map(color => contrast(color, background!))), await text.innerText()).toBeGreaterThanOrEqual(minimum);
}

async function checkFlow(flow: Locator, directedEdges: number) {
  const paths = flow.locator('path[data-from][data-to]');
  expect(await paths.count()).toBe(directedEdges);
  const problems = await flow.evaluate(el => {
    const boxes = new Map([...el.querySelectorAll<HTMLElement>('.chat-ui-flow-node[data-node]')].map(node => [node.dataset.node, node.getBoundingClientRect()]));
    const distance = (point: DOMPoint, box: DOMRect) => Math.hypot(Math.max(box.left - point.x, 0, point.x - box.right), Math.max(box.top - point.y, 0, point.y - box.bottom));
    const occupied = new Map<string, string>();
    const overlaps = new Set<string>();
    const problems: string[] = [];
    for (const path of el.querySelectorAll<SVGPathElement>('path[data-from][data-to]')) {
      const from = path.dataset.from!, to = path.dataset.to!, name = from + ' → ' + to;
      const length = path.getTotalLength();
      const point = (at: number) => new DOMPoint(path.getPointAtLength(at).x, path.getPointAtLength(at).y).matrixTransform(path.getScreenCTM()!);
      const start = distance(point(0), boxes.get(from)!);
      const end = distance(point(length), boxes.get(to)!);
      if (start <= 2 || start > 10 || end <= 2 || end > 10 || !path.hasAttribute('marker-end')) problems.push(name + ' endpoints');
      for (const [id, box] of boxes) {
        if (id === from || id === to) continue;
        for (let i = 0; i <= length; i += 0.75) if (distance(point(i), box) < 1) {
          problems.push(name + ' crosses ' + id);
          break;
        }
      }
      for (let i = 1; i < length - 1; i++) {
        const p = point(i), next = point(i + 1);
        const key = [Math.round(p.x), Math.round(p.y), Math.abs(next.x - p.x) > 0.5 ? 'x' : 'y'].join('/');
        const previous = occupied.get(key);
        if (previous && previous !== name) overlaps.add(previous + ' overlaps ' + name);
        occupied.set(key, name);
      }
    }
    return [...problems, ...overlaps];
  });
  expect(problems).toEqual([]);
}

async function openDisplayReview(page: Page, key: keyof typeof displayDocuments | 'media', theme: Theme) {
  const result = validateChatUiDocument(key === 'media' ? displayMediaDocument : displayDocuments[key]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const document = result.document;
  const messages = [
    { id: 2, parent_event_id: null, event_type: 'assistant_message', created_at: new Date(2000).toISOString(), payload: {
      content: renderText(document), timestamp: 2, tool_use_id: 'sel-2',
      ui: { schema_version: 1, revision: 1, ui_id: 'ui_' + 'e'.repeat(31) + '2', hash: 'f'.repeat(63) + '2', document },
    } },
    { id: 1, parent_event_id: null, event_type: 'user_message', created_at: new Date(1000).toISOString(), payload: { text: '확인', timestamp: 1 } },
  ];
  await installChatUiRoutes(page, { count: messages.length, theme });
  if (key === 'media') {
    await page.route(/\/api\/attachments\/(landscape|portrait)\/content\?/, async route => {
      const portrait = route.request().url().includes('portrait');
      const [width, height] = portrait ? [900, 1200] : [1200, 900];
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/></svg>` });
    });
  }
  await page.addInitScript(() => { localStorage.setItem('soul-language', 'ko'); });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.route('**/api/sessions/*/timeline?*', route => route.fulfill({ json: { messages, next_cursor: null } }));
  const root = await openChatUi(page, true);
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  await page.evaluate(() => document.fonts.ready);
  return root;
}

test.describe('PAS display corrections', () => {
  test.use({ timezoneId: 'Asia/Seoul', deviceScaleFactor: 2 });
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [360, 'light'], [360, 'dark'], [390, 'light']] as const) {
    test(`resources and diagrams ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 2400 });
      const root = await openDisplayReview(page, 'qResources', theme);
      const save = (key: string) => root.locator('[data-slot="chat-message-row"]').filter({ has: page.locator('.chat-ui') }).last().screenshot({ path: path.join(output, `chat-pas-${key}-${width}-${theme}.png`) });
      await save('qResources');
      expect(await root.locator('.chat-ui-chart-times span').first().innerText()).toBe('13:05');
      expect(await root.locator('.chat-ui-chart-times span').last().innerText()).toBe('14:05');
      expect(await root.locator('.chat-ui-chart-scale span:not(.chat-ui-chart-limit-label)').allTextContents()).toEqual(['0%', '50%', '100%']);
      const unit = root.locator('.chat-ui-stat[data-tone="warn"] .chat-ui-stat-unit');
      expect(await unit.count()).toBe(1);
      if (await unit.count()) {
        const style = await unit.evaluate(el => ({
          size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color,
          meta: getComputedStyle(el.closest('.chat-ui-stat')!.querySelector(':scope > .chat-ui-display-meta')!).color,
          gap: getComputedStyle(el.parentElement!).columnGap,
        }));
        expect(style).toEqual({ size: '12px', color: style.meta, meta: style.meta, gap: '4px' });
      }
      if (theme === 'light' && width === 1440) {
        await checkTextContrast(page, root.locator('.chat-ui-stat[data-tone="warn"] .chat-ui-stat-value').locator('span').first().or(root.locator('.chat-ui-stat[data-tone="warn"] .chat-ui-stat-value:not(:has(span))')), 3);
        await checkTextContrast(page, root.locator('.chat-ui-chart-limit-label'), 4.5);
      }
      const tracks = await root.locator('.chat-ui-bar-track').evaluateAll(els => els.map(el => {
        const { left, right } = el.getBoundingClientRect();
        return [left, right];
      }));
      for (const [left, right] of tracks) {
        expect(Math.abs(left - tracks[0]![0]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(right - tracks[0]![1]!)).toBeLessThanOrEqual(1);
      }
      const dots = await root.locator('[data-chat-ui-node="q_bars"] .chat-ui-chart-heading .chat-ui-chart-legend i')
        .evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
      expect(dots).toEqual(await root.locator('.chat-ui-bar-row').first().locator('.chat-ui-bar-fill').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor)));

      await page.unroute('**/api/sessions/*/timeline?*');
      await openDisplayReview(page, 'qDiagrams', theme);
      await save('qDiagrams');
      const marks = root.locator('.chat-ui-compare-item > span:first-child');
      expect(await marks.allTextContents()).toEqual(['', '', '', '✓', '✓', '−', '×']);
      for (const column of await root.locator('.chat-ui-compare-column').all()) {
        const starts = await column.locator('.chat-ui-compare-item').evaluateAll(items => items.map(item => {
          const range = document.createRange();
          range.selectNodeContents(item);
          range.setStartAfter(item.firstChild!);
          return range.getBoundingClientRect().x;
        }));
        expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(1);
      }
      await checkFlow(root.locator('[data-chat-ui-node="q_flow"] .chat-ui-flow:visible'), 5);
      await checkFlow(root.locator('[data-chat-ui-node="q_flow_two"] .chat-ui-flow:visible'), 2);
    });
  }
});

async function keyboardRing(page: Page, target: Locator, screenshotName: string) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const sides = [
    Array.from({ length: 5 }, (_, i) => ({ x: Math.floor(box.width / 2), y: i })),
    Array.from({ length: 5 }, (_, i) => ({ x: Math.floor(box.width / 2), y: Math.floor(box.height) - 1 - i })),
    Array.from({ length: 5 }, (_, i) => ({ x: i, y: Math.floor(box.height / 2) })),
    Array.from({ length: 5 }, (_, i) => ({ x: Math.floor(box.width) - 1 - i, y: Math.floor(box.height / 2) })),
  ];
  const capture = () => target.screenshot({ scale: 'css', animations: 'disabled' });
  await target.evaluate(el => (el as HTMLElement).blur());
  const idle = await pixels(page, await capture(), sides.flat());
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  expect(await target.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('auto');
  const focused = await target.screenshot({ scale: 'css', animations: 'disabled', path: path.join(output, screenshotName) });
  const active = await pixels(page, focused, sides.flat());
  sides.forEach((side, sideIndex) => {
    expect(side.some((_, i) => contrast(idle[sideIndex * 5 + i]!, active[sideIndex * 5 + i]!) > 1.25), `focus side ${sideIndex + 1}`).toBe(true);
  });
  await target.evaluate(el => (el as HTMLElement).blur());
}

test.describe('PAS table, focus and media corrections', () => {
  test.use({ deviceScaleFactor: 2 });
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [360, 'dark'], [390, 'light']] as const) {
    test(`list and table ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 2400 });
      const root = await openDisplayReview(page, 'qLists', theme);
      const row = root.locator('[data-slot="chat-message-row"]').filter({ has: page.locator('.chat-ui') }).last();
      await row.screenshot({ path: path.join(output, `chat-pas-qLists-${width}-${theme}.png`), animations: 'disabled' });
      if (theme === 'light' && width === 1440) {
        await checkTextContrast(page, root.locator('.chat-ui-step[data-state="failed"] .chat-ui-step-title'), 4.5);
      }
      if (width === 390) {
        const alignment = await root.locator('.chat-ui-list-row').first().evaluate(el => {
          const bounds = (selector: string) => el.querySelector(selector)!.getBoundingClientRect();
          const title = el.querySelector('.chat-ui-list-title')!;
          const titleBox = title.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
          const note = bounds('.chat-ui-list-note'), value = bounds('.chat-ui-list-value'), badge = bounds('[data-slot="status-chip"]');
          return { titleLines: titleBox.height / lineHeight, noteDelta: Math.abs(value.bottom - note.bottom),
            badgeDelta: Math.abs((badge.top + badge.height / 2) - (titleBox.top + lineHeight / 2)) };
        });
        expect(alignment.titleLines).toBeCloseTo(2, 0);
        expect(alignment.noteDelta).toBeLessThanOrEqual(1);
        expect(alignment.badgeDelta).toBeLessThanOrEqual(1);
      }
      const table = root.locator('.chat-ui-table-frame');
      const link = table.locator('a').first();
      await expect(link).toHaveCSS('text-decoration-line', 'underline');
      await table.evaluate(el => { el.scrollLeft = 120; });
      const header = await table.evaluate(el => {
        const first = el.querySelector('th')!;
        const rect = first.getBoundingClientRect();
        const x = Math.min(rect.x + rect.width / 2, el.getBoundingClientRect().right - 1);
        return { topCell: document.elementFromPoint(x, rect.y + rect.height / 2)?.closest('th') === first,
          background: getComputedStyle(first).backgroundColor, scrollLeft: el.scrollLeft };
      });
      expect(header.topCell).toBe(true);
      expect(header.background).not.toMatch(/^rgba\(|\/\s*(?:0|\.)/);
      if (width <= 390) expect(header.scrollLeft).toBeGreaterThan(0);
      expect(await table.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      expect(await table.locator('tbody td:first-child').evaluateAll(cells => cells.map(cell => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length;
      }))).toEqual([1, 1, 1]);
      if (width === 360) {
        const wrappedHeader = table.locator('thead th').nth(1);
        const wrapped = await wrappedHeader.innerText();
        await table.evaluate((el, label) => {
          for (const row of el.querySelectorAll('tr')) row.prepend(row.children[1]!);
          el.scrollLeft = 0;
          el.querySelector('th')!.textContent = label;
        }, wrapped);
        expect(await table.evaluate(el => el.querySelector('th')!.getBoundingClientRect().width / el.clientWidth)).toBeLessThanOrEqual(0.5);
      }
      if (width === 390 || width === 360) {
        const scroll = row.locator('.chat-ui-table-scroll');
        const scrollTo = (left: number) => table.evaluate((el, left) => { el.scrollLeft = left; }, left);
        const atEdge = async () => {
          const { width } = (await table.boundingBox())!;
          const x = Math.floor(width) - 3;
          return (await pixels(page, await table.screenshot({ scale: 'css' }), [{ x, y: 12 }]))[0]!;
        };
        await scrollTo(0);
        await expect(scroll).toHaveAttribute('data-more-right', 'true', { timeout: 1000 });
        expect(await scroll.evaluate(el => getComputedStyle(el, '::after').width)).toBe('24px');
        const fade = await atEdge();
        await scrollTo(10000);
        await expect(scroll).toHaveAttribute('data-more-right', 'false', { timeout: 1000 });
        const end = await atEdge();
        expect(Math.max(...fade.map((channel, i) => Math.abs(channel - end[i]!)))).toBeGreaterThan(4);
        await scrollTo(120);
        await expect(scroll).toHaveAttribute('data-scrolled', 'true', { timeout: 1000 });
        expect(await table.locator('th').first().evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/1px 0px 0px/);
        await row.screenshot({ path: path.join(output, `chat-pas-table-scrolled-${width}-${theme}.png`), animations: 'disabled' });
      }
      if (width === 1440) {
        for (const [i, link] of (await root.locator('a.chat-ui-list-row').all()).entries()) {
          await keyboardRing(page, link, `list-focus-${theme}-${i + 1}.png`);
        }
        await keyboardRing(page, table, `table-focus-${theme}.png`);
      }
      if (width === 390) {
        await page.setViewportSize({ width, height: 540 });
        await table.scrollIntoViewIfNeeded();
        const scroller = root.locator('[data-virtuoso-scroller="true"]');
        await table.hover();
        const before = await scroller.evaluate(el => el.scrollTop);
        await page.mouse.wheel(0, -200);
        await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(before);
      }
    });
  }

  for (const theme of ['light', 'dark'] as const) test(`original image ratios and HTML background ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    const root = await openDisplayReview(page, 'media', theme);
    for (const id of ['landscape', 'portrait']) {
      const node = root.locator(`[data-chat-ui-node="${id}"]`);
      const image = node.locator('img');
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const metrics = await node.evaluate(el => {
        const img = el.querySelector('img')!, box = img.getBoundingClientRect();
        const caption = el.querySelector('figcaption')!.getBoundingClientRect();
        const frame = getComputedStyle(img.parentElement!);
        return { width: box.width, gap: caption.y - box.bottom, before: box.top - el.previousElementSibling!.getBoundingClientRect().bottom,
          after: el.nextElementSibling!.getBoundingClientRect().top - caption.bottom, ratio: box.width / box.height, original: img.naturalWidth / img.naturalHeight,
          border: frame.borderTopWidth, radius: frame.borderTopLeftRadius };
      });
      expect(metrics.width).toBeLessThanOrEqual(360);
      expect(metrics.ratio).toBeCloseTo(metrics.original, 2);
      expect(metrics.gap).toBeCloseTo(8, 0);
      expect(Math.abs(metrics.before - 16)).toBeLessThanOrEqual(1);
      expect(metrics.after).toBeGreaterThan(metrics.gap);
      expect(metrics.radius).toBe('12px');
      expect(metrics.border).toBe('1px');
    }
    const html = root.locator('.chat-ui-html');
    await expect(html.locator('iframe').contentFrame().getByText('작은 정적 보고')).toBeVisible();
    const sample = [{ x: 24, y: 80 }];
    const [inner] = await pixels(page, await html.screenshot({ scale: 'css' }), sample);
    const [surround] = await pixels(page, await html.screenshot({
      scale: 'css', style: '.chat-ui-html iframe { visibility: hidden; }',
    }), sample);
    expect(Math.max(...inner!.map((n, i) => Math.abs(n - surround![i]!)))).toBeLessThanOrEqual(2);
    await root.locator('[data-slot="chat-message-row"]').filter({ has: page.locator('.chat-ui-html') }).last().screenshot({ path: path.join(output, `chat-pas-media-1440-${theme}.png`) });
  });
});
