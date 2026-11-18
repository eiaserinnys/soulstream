/**
 * 문서 패널 상태 시각 검수. 서버를 먼저 실행한다:
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43184 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs) \
 *   node unified-dashboard/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/card1684-document-panel-states.qa.ts
 * 수정 전 캡처: 기준 커밋의 소스를 제공하는 서버를 V3_QA_BASE_URL로 지정하고
 * CARD1684_BEFORE=1 을 실행 명령 앞에 붙인다.
 * 불변 비교 기준 캡처: CSS 변경 전 CARD1684_INVARIANT_BASELINE=1 로 실행한다.
 */
import type { Browser, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43184";
const before = process.env.CARD1684_BEFORE === "1";
const invariantBaseline = process.env.CARD1684_INVARIANT_BASELINE === "1";
const output = path.resolve(`.local/card1684/${invariantBaseline ? "invariant-before" : before ? "before" : "after"}`);
mkdirSync(output, { recursive: true });
type State = "empty" | "loading" | "error" | "content" | "editor-loading";

async function scene(browser: Browser, width: number, state: State, theme: "dark" | "light" = "dark") {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce", colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.addInitScript((currentTheme) => {
    localStorage.setItem("soul-dashboard-theme", currentTheme);
    localStorage.setItem("ls.webglGlass", "0");
  }, theme);
  await installV3VisualQaRoutes(page, {});
  await page.route("**/client/v3/dialogues-api.ts*", async route => {
    const response = await route.fetch();
    const replacement = state === "loading"
      ? "await new Promise(resolve => setTimeout(resolve, 8000)); value = document;"
      : state === "error"
        ? "return new Response('unavailable', { status: 503 });"
        : `value = { ...document, title: "", body: ${JSON.stringify(state === "empty" ? "" : "실제 문서 본문입니다. 읽기와 편집 화면을 확인합니다.")} };`;
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
    // 넓은 폭 작업 공간의 등장 애니메이션이 끝난 좌표를 잰다.
    await page.waitForTimeout(300);
    const metrics = await target.evaluate((el, stateName) => {
      const scroll = stateName === "empty" || stateName === "content" ? el.parentElement : el.closest(".overflow-auto");
      if (!scroll) throw new Error("본문 스크롤 영역이 없습니다.");
      const visibleParts = stateName === "loading" || stateName === "editor-loading"
        ? Array.from(el.querySelectorAll("svg, .v3-frame-loading-label")) : [el];
      if ((stateName === "loading" || stateName === "editor-loading") && visibleParts.length !== 2) {
        throw new Error("로딩 표시의 스피너와 글자를 찾지 못했습니다.");
      }
      const boxes = stateName === "error" ? (() => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return [range.getBoundingClientRect()];
      })() : visibleParts.map(part => part.getBoundingClientRect());
      const left = Math.min(...boxes.map(box => box.left));
      const top = Math.min(...boxes.map(box => box.top));
      const right = Math.max(...boxes.map(box => box.right));
      const bottom = Math.max(...boxes.map(box => box.bottom));
      const rect = { x: left, y: top, width: right - left, height: bottom - top };
      const area = scroll.getBoundingClientRect();
      const overlay = el.closest(".v3-folder-board-document-overlay");
      if (!overlay) throw new Error("문서 오버레이가 없습니다.");
      const overlayRect = overlay.getBoundingClientRect();
      const text = stateName === "empty" ? el.querySelector('[data-testid="markdown-empty"]') ?? el.querySelector("p") ?? el : stateName === "content" ? el.querySelector("p") ?? el : el;
      const style = getComputedStyle(text);
      const title = overlay.querySelector<HTMLInputElement>('input[aria-label="문서 제목"]')!;
      const titleStyle = getComputedStyle(title);
      const pathText = overlay.querySelector(".v3-chat-header small")!;
      const pathRange = document.createRange();
      pathRange.selectNodeContents(pathText);
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const brightness = (color: string, opacity = 1) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = getComputedStyle(scroll.parentElement!).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = 1;
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return (r + g + b) / 3;
      };
      const placeholder = getComputedStyle(title, "::placeholder");
      const header = title.parentElement!.getBoundingClientRect();
      const rim = overlay.querySelector<HTMLElement>(".liquid-glass-card__layer > span");
      const effect = overlay.querySelector<HTMLElement>(".liquid-glass-card__effect");
      return {
        target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        area: { x: area.x, y: area.y, width: area.width, height: area.height },
        overlay: { y: overlayRect.y, height: overlayRect.height, alignSelf: getComputedStyle(overlay).alignSelf },
        viewportHeight: window.innerHeight,
        geometry: { headerHeight: header.height, headerBottom: header.bottom, titleY: title.getBoundingClientRect().top, scrollTop: area.top },
        starts: { path: pathRange.getBoundingClientRect().left, title: title.getBoundingClientRect().left + parseFloat(titleStyle.paddingLeft) + parseFloat(titleStyle.borderLeftWidth), body: textRange.getBoundingClientRect().left },
        brightness: brightness(style.color, Number(style.opacity)),
        placeholderBrightness: brightness(placeholder.color, Number(placeholder.opacity)),
        corners: { overlay: getComputedStyle(overlay).borderTopLeftRadius, effect: effect ? getComputedStyle(effect).borderTopLeftRadius : null, rim: rim ? getComputedStyle(rim).borderTopLeftRadius : null },
        toggleVisible: (() => { const toggle = overlay.querySelector<HTMLElement>('[data-testid="v3-folder-board-document-overlay-expand"]')!; return !!toggle.getClientRects().length; })(),
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
    await page.screenshot({ path: path.join(output, `${theme === "light" ? "light-" : ""}${state}-${width}.png`), animations: "disabled" });
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

async function readerScene(browser: Browser, width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce", colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, {});
  try {
    await page.goto(`${baseUrl}/dialogues?sample=document-reader`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByTestId("internal-document-dialog");
    await dialog.getByText("문단 1.", { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: path.join(output, `reader-${width}.png`), animations: "disabled" });
  } finally {
    await context.close();
  }
}

async function transitionScene(browser: Browser, width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce", colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript({ content: "window.__name = (f) => f;" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, {});
  await page.route("**/client/v3/dialogues-api.ts*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes("value = document;")) throw new Error("샘플 문서 응답 위치를 찾지 못했습니다.");
    await route.fulfill({ response, body: source.replace("value = document;", 'await new Promise(r => setTimeout(r, 4000)); value = { ...document, title: "", body: "실제 문서 본문입니다." };') });
  });
  try {
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-slot="frame-loading"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const measure = () => page.evaluate(() => {
      const title = document.querySelector<HTMLElement>('input[aria-label="문서 제목"]')!;
      const header = title.parentElement!.getBoundingClientRect();
      return { headerHeight: header.height, headerBottom: header.bottom, titleY: title.getBoundingClientRect().top,
        scrollTop: title.parentElement!.nextElementSibling!.getBoundingClientRect().top,
        editDisabled: document.querySelector<HTMLButtonElement>('[data-testid="markdown-edit-start"]')?.disabled ?? null };
    });
    const during = await measure();
    await page.screenshot({ path: path.join(output, `transition-during-${width}.png`), animations: "disabled" });
    await page.getByTestId("markdown-read-body").waitFor({ state: "visible", timeout: 30_000 });
    const after = await measure();
    await page.screenshot({ path: path.join(output, `transition-after-${width}.png`), animations: "disabled" });
    return { during, after };
  } finally { await context.close(); }
}

const transitions: Record<number, Awaited<ReturnType<typeof transitionScene>>> = {};
const results = await runPlaywrightLifecycle({ lockName: "card1684-document-panel", timeoutMs: 300_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const measurements: Record<string, Awaited<ReturnType<typeof scene>>> = {};
  if (invariantBaseline) {
    measurements["content-1440"] = await scene(browser, 1440, "content");
  } else {
    for (const width of [1440, 390]) for (const state of ["empty", "loading", "error", "content", "editor-loading"] as const) {
      measurements[`${state}-${width}`] = await scene(browser, width, state);
    }
    for (const width of [1440, 390]) for (const state of ["empty", "content"] as const) {
      measurements[`light-${state}-${width}`] = await scene(browser, width, state, "light");
    }
    for (const width of [1440, 390]) transitions[width] = await transitionScene(browser, width);
  }
  for (const width of [1440, 390]) await readerScene(browser, width);
  return measurements;
});
if (invariantBaseline) {
  console.log(`불변 비교 기준 캡처: ${output}`);
  process.exit(0);
}
const failures: string[] = [];
for (const width of [1440, 390]) {
  for (const state of ["empty", "content"]) {
    const { starts, corners, toggleVisible } = results[`${state}-${width}`];
    if (Math.max(...Object.values(starts)) - Math.min(...Object.values(starts)) > 1) failures.push(`${state}-${width}: 왼쪽 시작선 불일치 ${JSON.stringify(starts)}`);
    if (toggleVisible !== (width === 1440)) failures.push(`${state}-${width}: 높이 토글 표시 불일치`);
    if (width === 390 && Object.values(corners).some(radius => radius !== null && radius !== "0px")) failures.push(`${state}-${width}: 좁은 화면 모서리 불일치 ${JSON.stringify(corners)}`);
  }
  const transition = transitions[width];
  for (const key of ["headerHeight", "headerBottom", "titleY", "scrollTop"] as const) {
    if (transition.during[key] !== transition.after[key]) failures.push(`transition-${width}: ${key} 이동`);
  }
  if (transition.during.editDisabled !== true || transition.after.editDisabled !== false) failures.push(`transition-${width}: 편집 단추 상태 불일치`);
  for (const theme of ["", "light-"]) {
    const empty = results[`${theme}empty-${width}`];
    const content = results[`${theme}content-${width}`];
    if (Math.abs(empty.brightness - empty.placeholderBrightness) >= Math.abs(content.brightness - empty.placeholderBrightness)) failures.push(`${theme}empty-${width}: 보조 톤 불일치`);
  }
  for (const state of ["loading", "error", "editor-loading"]) {
    const m = results[`${state}-${width}`];
    if (m.dx > 2 || m.dy > 2) failures.push(`${state}-${width}: 가운데 오차 ${m.dx}, ${m.dy}`);
    if (width === 390 && m.area.height < m.viewportHeight / 2) failures.push(`${state}-${width}: 본문 영역 높이가 화면의 절반보다 작음 (${m.area.height}px)`);
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
const invariants: Record<string, string> = {};
if (!before) for (const name of ["reader-1440", "reader-390"]) {
  const baselinePath = path.resolve(`.local/card1684/invariant-before/${name}.png`);
  if (!existsSync(baselinePath)) {
    invariants[name] = "기준 캡처 없음";
    continue;
  }
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  invariants[name] = hash(baselinePath) === hash(path.join(output, `${name}.png`)) ? "일치" : "불일치";
  if (invariants[name] !== "일치") failures.push(`${name}: 변경 전후 캡처 불일치`);
}
const baselineResultPath = path.resolve(".local/card1684/before/visual-result.json");
if (!before && existsSync(baselineResultPath)) {
  const previous = JSON.parse(readFileSync(baselineResultPath, "utf8"));
  const old = previous.results?.["content-1440"];
  const current = results["content-1440"];
  const unchanged = old && JSON.stringify(old.area) === JSON.stringify(current.area) && JSON.stringify(old.overlay) === JSON.stringify(current.overlay) && JSON.stringify(old.geometry) === JSON.stringify(current.geometry);
  invariants["content-1440-layout"] = unchanged ? "시작선 이외 배치 일치" : "시작선 이외 배치 불일치";
  if (!unchanged) failures.push("content-1440: 시작선 이외 배치 불일치");
}
const report = { before, results, transitions, invariants, failures };
writeFileSync(path.resolve(`.local/card1684/${before ? "before/visual-result.json" : "visual-result.json"}`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
