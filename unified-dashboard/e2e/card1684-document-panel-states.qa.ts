/**
 * 문서 패널 상태 시각 검수. 서버를 먼저 실행한다:
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43184 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs) \
 *   node unified-dashboard/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/card1684-document-panel-states.qa.ts
 * 수정 전 캡처: CARD1684_BEFORE=1 을 실행 명령 앞에 붙인다.
 */
import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43184";
const before = process.env.CARD1684_BEFORE === "1";
const output = path.resolve(`.local/card1684/${before ? "before" : "after"}`);
mkdirSync(output, { recursive: true });
type State = "empty" | "loading" | "error" | "content" | "editor-loading";

async function scene(browser: Browser, width: number, state: State) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce", colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, {});
  await page.route("**/client/v3/dialogues-api.ts*", async route => {
    const response = await route.fetch();
    const replacement = state === "loading"
      ? "await new Promise(resolve => setTimeout(resolve, 8000)); value = document;"
      : state === "error"
        ? "return new Response('unavailable', { status: 503 });"
        : `value = { ...document, title: "제목 없는 문서", body: ${JSON.stringify(state === "empty" ? "" : "실제 문서 본문입니다. 읽기와 편집 화면을 확인합니다.")} };`;
    const source = await response.text();
    if (!source.includes("value = document;")) throw new Error("샘플 문서 응답 위치를 찾지 못했습니다.");
    await route.fulfill({ response, body: source.replace("value = document;", replacement) });
  });
  if (state === "editor-loading") {
    await page.route("**/MarkdownCodeMirrorEditor.tsx*", async route => {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await route.fallback();
    });
  }
  try {
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    if (state === "editor-loading") await page.getByTestId("markdown-edit-start").click({ timeout: 30_000 });
    const selector = state === "loading" || state === "editor-loading" ? '[data-slot="frame-loading"]'
      : state === "error" ? '[data-testid="markdown-load-error"]' : '[data-testid="markdown-read-body"]';
    const target = page.locator(selector).first();
    await target.waitFor({ state: "visible", timeout: 30_000 });
    const metrics = await target.evaluate((el, stateName) => {
      const scroll = stateName === "empty" || stateName === "content" ? el.parentElement : el.closest(".overflow-auto");
      if (!scroll) throw new Error("본문 스크롤 영역이 없습니다.");
      const rect = el.getBoundingClientRect();
      const area = scroll.getBoundingClientRect();
      const text = stateName === "empty" ? el.querySelector('[data-testid="markdown-empty"]') ?? el.querySelector("p") ?? el : stateName === "content" ? el.querySelector("p") ?? el : el;
      const style = getComputedStyle(text);
      return {
        target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        area: { x: area.x, y: area.y, width: area.width, height: area.height },
        dx: Math.abs(rect.x + rect.width / 2 - area.x - area.width / 2),
        dy: Math.abs(rect.y + rect.height / 2 - area.y - area.height / 2),
        color: style.color, fontWeight: style.fontWeight, fontSize: style.fontSize,
        userSelect: style.userSelect,
        textSmall: text.classList.contains("text-sm"),
        emptyMarker: !!el.querySelector('[data-testid="markdown-empty"]'),
        text: text.textContent,
        overflow: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, scroll.scrollWidth - scroll.clientWidth),
      };
    }, state);
    await page.screenshot({ path: path.join(output, `${state}-${width}.png`), animations: "disabled" });
    let resize: unknown = null;
    if (state === "content" && width === 1440) {
      const title = page.locator('input[aria-label="문서 제목"]').first();
      const value = await title.inputValue();
      await page.setViewportSize({ width: 390, height: 844 });
      resize = { titlePreserved: await title.inputValue() === value, bodyVisible: await target.isVisible(), overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
    }
    return { ...metrics, resize };
  } finally {
    await context.close();
  }
}

const results = await runPlaywrightLifecycle({ lockName: "card1684-document-panel", timeoutMs: 300_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const measurements: Record<string, Awaited<ReturnType<typeof scene>>> = {};
  for (const width of [1440, 390]) for (const state of ["empty", "loading", "error", "content", "editor-loading"] as const) {
    measurements[`${state}-${width}`] = await scene(browser, width, state);
  }
  return measurements;
});
const failures: string[] = [];
for (const width of [1440, 390]) {
  for (const state of ["loading", "error", "editor-loading"]) {
    const m = results[`${state}-${width}`];
    if (m.dx > 2 || m.dy > 2) failures.push(`${state}-${width}: 가운데 오차 ${m.dx}, ${m.dy}`);
  }
  const empty = results[`empty-${width}`];
  const content = results[`content-${width}`];
  if (!empty.emptyMarker || !empty.textSmall || empty.color === content.color || Number(empty.fontWeight) !== 400 || empty.userSelect !== "none") failures.push(`empty-${width}: 빈 문서 스타일 불일치`);
  for (const state of ["empty", "loading", "error", "content", "editor-loading"]) {
    if (results[`${state}-${width}`].overflow > 0) failures.push(`${state}-${width}: 가로 넘침`);
  }
}
const resize = results["content-1440"].resize as { titlePreserved: boolean; bodyVisible: boolean; overflow: number };
if (!resize.titlePreserved || !resize.bodyVisible || resize.overflow > 0) failures.push("창 크기 변경 후 본문 또는 제목 불일치");
const report = { before, results, failures };
writeFileSync(path.resolve(`.local/card1684/${before ? "before/visual-result.json" : "visual-result.json"}`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
