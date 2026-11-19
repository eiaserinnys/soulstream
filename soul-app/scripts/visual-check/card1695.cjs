// After export:components: node card1695.cjs <playwright-path> <output-dir>
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { chromium } = require(path.resolve(process.argv[2]));
const output = path.resolve(process.argv[3]);
const root = path.resolve('unified-dashboard/dist/assets/ios-components');
const prefix = '/assets/ios-components/';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/auth/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"authenticated":true}'); return; }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(root, '.' + url.pathname.slice(prefix.length - 1));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try { const body = await fs.readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
(async () => {
  await fs.mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  for (const width of [1440, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: true, reducedMotion: 'reduce' });
    await page.goto(base + prefix + 'index.html?section=dialogues');
    await page.getByTestId('component-review').waitFor();
    await page.getByLabel('기술 상세', { exact: true }).click();
    await page.getByText('작성창 오류 상세', { exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(output, `app-sheet-${width}.png`) });
    await page.getByTestId('settings-segment-review-dialogue-task-output').click();
    await page.getByLabel('선택한 다이얼로그 열기', { exact: true }).click();
    await page.getByTestId('runtime-tasks-header-touch').click();
    await page.getByTestId('runtime-task-output-touch-public-task').waitFor();
    await page.screenshot({ path: path.join(output, `app-tasks-${width}.png`) });
    console.log('captured app', width);
    await page.close();
  }
  await browser.close(); server.close();
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
