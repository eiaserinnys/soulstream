import { expect, test, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installV3VisualQaRoutes } from './v3-visual-fixtures';

// Uses the actual registered RN web export and web samples; no operational writes.
const output = path.resolve('../../../.local/artifacts/20261004-input-growth');
const appRoot = path.resolve('dist/assets/ios-components');
let server: Server, appUrl: string;
const metrics: Record<string, unknown> = {};
test.beforeAll(async () => {
  await mkdir(output, { recursive: true });
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://fixture.local').pathname;
    if (pathname === '/api/auth/status') { res.setHeader('Content-Type', 'application/json'); res.end('{"authenticated":true}'); return; }
    const file = path.resolve(appRoot, '.' + pathname.replace('/assets/ios-components', ''));
    if (!file.startsWith(appRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' } as Record<string,string>)[path.extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}/assets/ios-components/index.html`;
});
test.afterAll(async () => {
  let previous = {};
  try { previous = JSON.parse(await readFile(path.join(output, 'metrics.json'), 'utf8')); } catch {}
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify({ ...previous, ...metrics }, null, 2));
  await new Promise<void>(resolve => server.close(() => resolve()));
});
async function measure(field: Locator) {
  return field.evaluate((el: HTMLTextAreaElement) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return { height: r.height, x: r.x, width: r.width, scroll: el.scrollHeight, client: el.clientHeight,
      min: parseFloat(s.minHeight) || 0, max: parseFloat(s.maxHeight), font: s.fontSize,
      line: parseFloat(s.lineHeight), padding: s.padding, whiteSpace: s.whiteSpace,
      textX: r.x + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), overflow: s.overflowY };
  });
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}
async function growth(page: Page, field: Locator, name: string, controls?: Locator) {
  await field.waitFor({ state: 'visible' });
  await field.fill('');
  const initial = await measure(field);
  const buttonHeights = controls ? await controls.evaluateAll(els => els.map(el => el.getBoundingClientRect().height)) : [];
  const fourLines = await field.evaluate((el: HTMLTextAreaElement) => {
    const s = getComputedStyle(el), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
    ctx.font = `${s.fontSize} ${s.fontFamily}`;
    const width = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    return '가'.repeat(Math.floor(width / ctx.measureText('가').width) * 3 + 2);
  });
  const states: Record<string, unknown> = { empty: initial };
  await capture(page, name + '-empty');
  await field.fill('한 줄');
  await expect.poll(async () => (await measure(field)).height).toBe(initial.height);
  for (const [state, text] of [['soft-four', fourLines], ['enter-four', '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄']]) {
    await field.fill(text);
    await expect.poll(async () => (await measure(field)).height).toBeGreaterThanOrEqual(initial.height);
    await expect.poll(async () => { const m = await measure(field); return m.scroll <= m.client + 1; }).toBe(true);
    const m = await measure(field);
    if (initial.min < m.line * 4) expect(m.height).toBeGreaterThan(initial.height);
    states[state] = m;
    if (controls) expect(await controls.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))).toEqual(buttonHeights);
    await capture(page, name + '-' + state);
    await field.fill('한 줄');
    await expect.poll(async () => (await measure(field)).height).toBe(initial.height);
    states[state + '-deleted'] = await measure(field);
    await capture(page, name + '-' + state + '-deleted');
  }
  await field.fill('줄\n'.repeat(30));
  await expect.poll(async () => (await measure(field)).height).toBe(initial.max);
  expect((await measure(field)).scroll).toBeGreaterThan((await measure(field)).client);
  states.cap = await measure(field);
  await capture(page, name + '-cap');
  await field.fill('');
  await expect.poll(async () => (await measure(field)).height).toBe(initial.height);
  states.clear = await measure(field);
  await capture(page, name + '-clear');
  metrics[name] = { states, buttonHeights };
}
for (const platform of ['rn', 'web']) for (const width of [1440, 390]) test(`${platform} real inputs grow, shrink and keep controls and inset ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' });
  await page.addInitScript(() => { localStorage.setItem('ls.webglGlass', '0'); });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installV3VisualQaRoutes(page);
  await page.route('**/api/auth/status', route => route.fulfill({json:{authenticated:true,user:{email:'qa@example.test',name:'QA',isAdmin:true}}}));
  if (platform === 'rn') {
  await page.goto(`${appUrl}?section=chat&theme=${width === 390 ? 'dark' : 'light'}`);
  await growth(page, page.getByLabel('공개 예시 메시지', { exact: true }), `rn-basic-${width}`, page.getByTestId('chat-composer-send-button'));
  await growth(page, page.getByLabel('embedded 예시 메시지', { exact: true }), `rn-embedded-${width}`, page.getByTestId('chat-composer-attach-button'));
  const basic = page.getByLabel('공개 예시 메시지', { exact: true });
  await basic.fill('복원할 긴 초안 '.repeat(25));
  const send = page.getByTestId('chat-composer-send-button').first();
  await send.click();
  await expect(basic).toHaveValue('');
  expect((await measure(basic)).height).toBe(48);
  for (const sample of ['card-create', 'session-create']) {
    await page.goto(`${appUrl}?section=dialogues&sample=${sample}&theme=${width === 390 ? 'dark' : 'light'}`);
    const field = sample === 'card-create' ? page.getByLabel('요청 원문', {exact:true}) : page.getByTestId('succession-initial-instruction');
    await growth(page, field, `rn-${sample}-${width}`);
    if (sample === 'card-create') {
      const title = page.getByLabel('카드 제목', {exact:true});
      const titleX = await title.evaluate(el => el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft));
      const requestX = (await measure(field)).textX;
      const selectionX = await page.getByLabel('카드 폴더 선택', {exact:true}).evaluate(el => el.firstElementChild!.getBoundingClientRect().x);
      expect(Math.abs(titleX - requestX)).toBeLessThanOrEqual(1);
      expect(Math.abs(titleX - selectionX)).toBeLessThanOrEqual(1);
      metrics[`rn-inset-${width}`] = { titleX, requestX, selectionX };
    }
    await capture(page, `rn-${sample}-${width}-form`);
  }
  } else {
  for (const [sample, label] of [['new-session', '초기 지시'], ['card-create', '요청 원문']]) {
    await page.goto(`/dialogues?sample=${sample}`);
    await growth(page, page.getByLabel(label, {exact:true}), `web-${sample}-${width}`);
    if (sample === 'card-create') {
      const titleX = await page.getByLabel('카드 제목').evaluate(el => el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).borderLeftWidth));
      const requestX = (await measure(page.getByLabel(label,{exact:true}))).textX;
      expect(Math.abs(titleX - requestX)).toBeLessThanOrEqual(1);
      metrics[`web-inset-${width}`] = {titleX, requestX};
    }
    await capture(page, `web-${sample}-${width}-form`);
  }
  await page.goto('/components');
  await growth(page, page.getByLabel('검수 메시지', {exact:true}), `web-card-composer-${width}`, page.getByRole('button',{name:'샘플 전송',exact:true}));
  }
  expect(errors).toEqual([]);
});

test('rn existing draft reflows when the same input width changes', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(appUrl + '?section=chat');
  const field = page.getByLabel('공개 예시 메시지', {exact:true});
  const draft = '복원한 초안 '.repeat(35);
  await field.fill(draft);
  const wide = await measure(field);
  await page.setViewportSize({width:390,height:1000});
  await expect.poll(async () => (await measure(field)).height).toBe(128);
  await expect(field).toHaveValue(draft);
  const narrow = await measure(field);
  await capture(page, 'rn-draft-width-narrow');
  await page.setViewportSize({width:1440,height:1000});
  await expect.poll(async () => (await measure(field)).height).toBe(wide.height);
  await expect(field).toHaveValue(draft);
  await capture(page, 'rn-draft-width-wide');
  metrics['rn-width-draft'] = {wide,narrow,restored:await measure(field)};
});