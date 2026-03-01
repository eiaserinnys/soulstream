import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist', 'client');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  const filePath = path.join(distDir, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise(r => srv.listen(0, r));
const port = srv.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

const result = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;
  const cs = getComputedStyle(body);
  const rootStyle = getComputedStyle(html);

  const vars = {};
  ['--background','--foreground','--card','--border','--muted-foreground','--destructive','--input'].forEach(v => {
    vars[v] = rootStyle.getPropertyValue(v).trim();
  });

  const buttons = Array.from(document.querySelectorAll('[data-slot="button"]'));
  const buttonInfo = buttons.map(b => {
    const s = getComputedStyle(b);
    return { text: b.textContent?.trim(), bg: s.backgroundColor, padding: s.padding, borderRadius: s.borderRadius };
  });

  const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));
  const badgeInfo = badges.map(b => {
    const s = getComputedStyle(b);
    return { text: b.textContent?.trim(), bg: s.backgroundColor, color: s.color, padding: s.padding };
  });

  return {
    bodyBg: cs.backgroundColor,
    hasDarkClass: html.classList.contains('dark'),
    vars,
    buttonCount: buttons.length,
    buttonInfo,
    badgeCount: badges.length,
    badgeInfo,
  };
});

console.log(JSON.stringify(result, null, 2));

await page.screenshot({ path: path.join(__dirname, 'css-check.png'), fullPage: true });
console.log('Screenshot saved');

await browser.close();
srv.close();
