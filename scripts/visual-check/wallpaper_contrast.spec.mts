// 카드 #1911: 기본 그림 여덟 장을 깐 대시보드를 README 데모의 운영 형태 표본(폴더 트리, 카드, 세션)으로 찍고,
// 글자 상자 좌표와 패널 좌표를 함께 남긴다. 대비 계산은 wallpaper_contrast.py가 캡처 화소로 한다.
// 실행은 settings_wallpaper.py --contrast가 부른다. 직접 돌리면:
//   REVIEW_DIST=<dist> REVIEW_OUT=<폴더> REVIEW_TAG=<접두어> unified-dashboard/node_modules/.bin/playwright test --config scripts/visual-check/wallpaper_contrast.config.mts
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { test, expect, type Page } from "../../unified-dashboard/node_modules/@playwright/test/index.mjs";
import { installReadmeDemoRoutes, readmeDemoIds } from "../../unified-dashboard/e2e/readme-demo/demo-fixtures.ts";
import { installDemoEventSource } from "../../unified-dashboard/e2e/readme-demo/demo-event-source.ts";

const DIST = resolve(process.env.REVIEW_DIST ?? "unified-dashboard/dist");
const OUT = process.env.REVIEW_OUT ?? "/tmp/wallpaper-contrast";
const TAG = process.env.REVIEW_TAG ?? "";

type Combo = { theme: "dark" | "light"; wallpaper: string; glass: "css" | "webgl"; width: number; tint?: number };
const ALL = ["dawn-ridge", "aurora", "silk-curves", "lake-horizon", "desert-dunes", "misty-forest", "moonlit-sea", "milky-way"];
const THEMES = ["dark", "light"] as const;
const COMBOS: Combo[] = [];
for (const theme of THEMES) {
  for (const wallpaper of ["bokeh", "metal", "plain", ...ALL]) COMBOS.push({ theme, wallpaper, glass: "css", width: 1440 });
  for (const wallpaper of ["bokeh", "moonlit-sea", "desert-dunes"]) COMBOS.push({ theme, wallpaper, glass: "css", width: 390 });
}
for (const tint of [0.62, 0.42]) {
  for (const [theme, wallpaper] of [["light", "moonlit-sea"], ["dark", "desert-dunes"]] as const) {
    COMBOS.push({ theme, wallpaper: "bokeh", glass: "webgl", width: 1440, tint });
    COMBOS.push({ theme, wallpaper, glass: "webgl", width: 1440, tint });
  }
}
const ONLY = process.env.REVIEW_ONLY;

const comboName = (c: Combo) => `${TAG}${c.theme}-${c.wallpaper}-${c.glass}-w${c.width}${c.tint === undefined ? "" : `-t${c.tint}`}`;

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".jpg": "image/jpeg" };
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = resolve(DIST, "." + path);
    if (!file.startsWith(DIST)) { res.statusCode = 403; return res.end(); }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(DIST, "index.html");
    }
    try {
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await mkdir(OUT, { recursive: true });
});
test.afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

const PAGE_READ = `() => {
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('[aria-hidden="true"]')) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const panel = el.closest('.dashboard-sidebar, .dashboard-chat-panel, [class*="right-panel"], [data-testid="v3-global-toolbar"], .v3-postit-card');
    boxes.push({ text: text.slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, size: style.fontSize,
      panel: panel ? (panel.getAttribute('data-testid') || panel.className.toString().split(' ').filter(c => /sidebar|panel|toolbar|postit/.test(c))[0] || panel.tagName) : 'none' });
  }
  const panels = [...document.querySelectorAll('.glass, .glass-strong, [data-testid="v3-global-toolbar"]')].map(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).filter(r => r.w * r.h > 20000);
  return { boxes, panels, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', webglState: document.documentElement.getAttribute('data-webgl-glass'), mode: document.documentElement.getAttribute('data-wallpaper-mode') };
}`;

async function prepare(page: Page, combo: Combo) {
  const wallpaper = ["bokeh", "metal", "plain"].includes(combo.wallpaper) ? { mode: combo.wallpaper } : { mode: "photo", customImage: `/wallpapers/${combo.wallpaper}.webp` };
  const glass = { enabled: true, refraction: 75, blur: 5, chromatic: 0.8, specular: 0.25, tint: combo.tint ?? 0.62 };
  await page.addInitScript(({ theme, wallpaper, webgl }) => {
    localStorage.setItem("soul-dashboard-theme", theme);
    localStorage.setItem("soul-wallpaper", JSON.stringify(wallpaper));
    localStorage.setItem("ls.webglGlass", webgl ? "1" : "0");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }), controller: null, addEventListener: () => undefined, removeEventListener: () => undefined } });
  }, { theme: combo.theme, wallpaper, webgl: combo.glass === "webgl" });
  await installDemoEventSource(page);
  await installReadmeDemoRoutes(page, { registeredApi: [], unregisteredApi: [] });
  // README 표본의 서버 설정(올린 사진, 낮은 유리 농도)을 이번 검수의 그림과 유리값으로 갈음한다. 뒤에 건 라우트가 먼저 받는다.
  await page.route("**/api/user/preferences**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    email: "demo@example.com", preferences: { appearance: combo.theme, wallpaper, glass }, hasBackground: false, backgroundUrl: null, updatedAt: null,
  }) }));
}

for (const combo of COMBOS) {
  const name = comboName(combo);
  if (ONLY && !name.includes(ONLY)) continue;
  // 무거워 한 호출에 다 못 돌릴 때를 위해 이미 찍은 조합은 건너뛴다. 다시 찍으려면 REVIEW_FORCE=1.
  if (!process.env.REVIEW_FORCE && existsSync(`${OUT}/${name}.json`) && existsSync(`${OUT}/${name}.png`)) continue;
  test(name, async ({ page }) => {
    await page.setViewportSize({ width: combo.width, height: combo.width === 390 ? 844 : 900 });
    await prepare(page, combo);
    await page.goto(`${base}/?folder=${readmeDemoIds.folderId}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(document.querySelector(".v3-shell")), null, { timeout: 60_000 });
    const cards = page.getByTestId("v3-planner-scroll").getByTestId("v3-folder-cards-section");
    if (combo.width > 640) {
      await page.getByRole("button", { name: "📱 Aurora 날씨 앱 펼치기", exact: true }).click();
      await cards.getByRole("button", { name: "일반 보기", exact: true }).click();
    }
    await expect(cards.locator(".v3-postit-card").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (combo.wallpaper !== "bokeh" && combo.wallpaper !== "metal" && combo.wallpaper !== "plain") {
      await page.waitForFunction((p) => getComputedStyle(document.querySelector(".wallpaper-wall-dark")!).backgroundImage.includes(p), `/wallpapers/${combo.wallpaper}.webp`, { timeout: 15_000 });
    }
    await page.waitForTimeout(combo.glass === "webgl" ? 2500 : 1200);
    await page.mouse.move(-10, -10);
    const read = await page.evaluate(`(${PAGE_READ})()`);
    await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
    await writeFile(`${OUT}/${name}.json`, JSON.stringify({ combo, ...(read as object) }, null, 1));
  });
}
