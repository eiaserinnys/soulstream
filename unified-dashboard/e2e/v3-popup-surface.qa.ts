import { koreanLocale } from "./korean-locale.mjs";
/**
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43183 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath unified-dashboard/node_modules/@playwright/test/../../playwright/index.mjs) V3_POPUP_BASELINE=1 node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/v3-popup-surface.qa.ts
 * Run again without V3_POPUP_BASELINE to compare against .local/card1619/before/metrics.json.
 * Set V3_POPUP_FOLDER_BEFORE=1 before moving the CSS rule to capture the folder picker regression.
 * CHROMIUM_PATH may be set to a compatible Chrome; otherwise Playwright Chromium is used.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43183";
const baseline = process.env.V3_POPUP_BASELINE === "1";
const folderBefore = process.env.V3_POPUP_FOLDER_BEFORE === "1";
const checkboxBefore = process.env.V3_CHECKBOX_BEFORE === "1";
const output = path.resolve(`.local/card1619/${checkboxBefore ? "before-2" : folderBefore ? "before-layer" : baseline ? "before" : "after-2"}`);
const beforePath = path.resolve(".local/card1619/before/metrics.json");
const before = baseline || folderBefore || checkboxBefore ? null : JSON.parse(readFileSync(beforePath, "utf8"));
mkdirSync(output, { recursive: true });

type Surface = { background: string; backdrop: string; alpha: number };
type Entry = { theme: string; glass: string; width: number; canvas: boolean; surfaces: Record<string, Surface>; interactions: Record<string, unknown> };
const results = await runPlaywrightLifecycle({
  lockName: "card1619-popup-surface", timeoutMs: 1_200_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
}, async ({ browser }: { browser: Browser }) => {
  if (folderBefore) {
    const surfaces: Record<string, Surface> = {};
    await captureFolderPicker(browser, "dark", surfaces);
    assert(surfaces["card-folder"].alpha < 1, "변경 전 폴더 선택 배경이 이미 불투명합니다.");
    return [{ theme: "dark", glass: "0", width: 1440, canvas: false, surfaces, interactions: {} }];
  }
  const rows: Entry[] = [];
  const cases = checkboxBefore
    ? [["dark", "1", 1440], ["dark", "1", 390]] as const
    : baseline
    ? [["dark", "0", 390], ["dark", "1", 1440], ["light", "1", 1440], ["dark", "0", 1440]] as const
    : [["dark", "1", 1440], ["dark", "1", 390], ["light", "1", 1440], ["light", "1", 390], ["dark", "0", 1440], ["dark", "0", 390], ["light", "0", 1440], ["light", "0", 390]] as const;
  for (const [theme, glass, width] of cases) {
    console.log(`검수 ${theme} glass=${glass} ${width}`);
    rows.push(await runCase(browser, theme, glass, width));
  }
  return rows;
});
writeFileSync(path.join(output, "metrics.json"), JSON.stringify(results, null, 2));
if (!baseline && !folderBefore && !checkboxBefore) {
  for (const row of results) {
    if (row.glass === "1") {
      const reference = before.find((item: Entry) => item.theme === row.theme && item.glass === "1" && item.width === 1440);
      assert(reference, `기준값 없음 ${row.theme}`);
      for (const [name, surface] of Object.entries(row.surfaces)) {
        const previous = reference.surfaces[name];
        assert(previous && surface.backdrop === previous.backdrop, `켬 블러 불일치 ${name}`);
        if (["succession", "document", "alert"].includes(name)) assert(surface.background === previous.background, `대화상자 바탕 불일치 ${name}`);
        else assert(surface.alpha >= 0.85, `켬 팝업이 너무 투명함 ${name}: ${surface.alpha}`);
      }
    } else if (row.glass === "0") {
      for (const [name, surface] of Object.entries(row.surfaces)) assert(surface.alpha === 1, `불투명하지 않음 ${name}: ${JSON.stringify(surface)}`);
    }
  }
}
console.log(JSON.stringify({ baseline, output, results }, null, 2));

async function runCase(browser: Browser, theme: string, glass: string, width: number): Promise<Entry> {
  const height = width === 1440 ? 900 : 844;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme as "dark" | "light", reducedMotion: "reduce", timezoneId: "Asia/Seoul", locale: koreanLocale });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const surfaces: Record<string, Surface> = {};
  const interactions: Record<string, unknown> = {};
  await page.addInitScript(({ theme, glass }) => {
    localStorage.setItem("soul-dashboard-theme", theme);
    localStorage.setItem("ls.webglGlass", glass);
    (window as typeof window & { __name?: unknown }).__name = (f: unknown) => f;
    const raf = window.requestAnimationFrame.bind(window);
    let glassFrames = 0;
    if (glass === "1") window.requestAnimationFrame = callback => callback.name === "renderFrame" && glassFrames++ > 0 ? 0 : raf(callback);
  }, { theme, glass });
  await installV3VisualQaRoutes(page, { successionPickerRuns: true, contextMenuParity: true,
    sessionModelPresets: { "run-alpha-1": "qa-standard", "run-alpha-2": "qa-standard" },
    sessionReasoningEfforts: { "run-alpha-1": "ultra", "run-alpha-2": "ultra" },
    timelineEventCount: 1, timelineContentByEventId: { 1: "[문서 링크](/api/markdown-documents/doc-1)" }, liveEventText: "검수 메시지" });
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: { model_presets: [{ id: "qa-standard", label: "QA 표준 모델", backend: "codex", available: true, supported_efforts: ["low", "medium", "high"], default_effort: "medium" }] } }));
  await page.route("**/api/sessions", route => route.request().method() === "POST" ? route.fulfill({ status: 500, json: { detail: "연결을 확인할 수 없습니다." } }) : route.fallback());
  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    if (width === 390) await page.getByTestId("v3-mobile-tab-projects").click();
    const task = width === 390 ? page.getByText("카드 밀도와 계층 최종 QA", { exact: true }).and(page.locator(":visible")).first() : page.getByTestId("v3-starred-task-row-task-alpha");
    try { await task.waitFor({ state: "visible", timeout: 15_000 }); }
    catch (error) {
      console.log("화면 진단", (await page.locator("body").innerText()).slice(0, 3000));
      await page.screenshot({ path: path.join(output, "diagnostic.png"), timeout: 60_000 });
      throw error;
    }
    if (glass === "1") await page.locator('[data-liquid-glass-webgl="true"]').first().waitFor({ state: "attached", timeout: 30_000 });
    const canvas = await page.locator('[data-liquid-glass-webgl-provider="true"]').count() > 0 && await page.locator('[data-liquid-glass-webgl="true"]').count() > 0;
    assert(glass === "0" || canvas, "유리 켬에서 WebGL 캔버스 또는 표면이 없음");
    if (width === 1440) {
      await task.click({ button: "right" });
      await capture(page, page.locator('[data-slot="menu-popup"]:visible'), "menu", theme, glass, width, height, surfaces);
      await page.keyboard.press("Escape");
    }
    await task.click();
    console.log("폴더 열기");
    await page.locator(".v3-run-row").filter({ hasText: "세션 #1" }).first().waitFor({ state: "visible" });
    const project = page.getByTestId("v3-project-context");
    await project.getByRole("button", { name: "atom 추가", exact: true }).click();
    console.log("컨텍스트 열기");
    const popover = page.locator('[data-slot="popover-popup"]:visible').filter({ hasText: "atom 노드" });
    await capture(page, popover, "project-context", theme, glass, width, height, surfaces);
    const checkbox = popover.getByRole("checkbox", { name: "제목만 포함" });
    const label = checkbox.locator("..");
    interactions.checkboxDelta = await label.evaluate(el => {
      const input = el.querySelector('input[type="checkbox"]')!;
      const text = [...el.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!text) throw new Error("체크박스 라벨 글을 찾지 못했습니다.");
      const range = document.createRange(); range.selectNodeContents(text);
      const a = input.getBoundingClientRect(); const b = range.getBoundingClientRect();
      return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
    });
    await label.scrollIntoViewIfNeeded();
    const box = await label.boundingBox();
    if (!box) throw new Error("체크박스 라벨 좌표가 없습니다.");
    const cdp = await context.newCDPSession(page);
    const closeup = await cdp.send("Page.captureScreenshot", { clip: { ...box, scale: 3 } });
    writeFileSync(path.join(output, `${theme}-${glass}-${width}-checkbox.png`), Buffer.from(closeup.data, "base64"));
    await cdp.detach();
    if (checkboxBefore) return { theme, glass, width, canvas, surfaces, interactions };
    assert(Number(interactions.checkboxDelta) <= 2, `체크박스 정렬 불일치 ${theme} ${glass} ${width}: ${interactions.checkboxDelta}`);
    await page.keyboard.press("Escape");
    if (await popover.isVisible()) await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    interactions.popoverEscape = !(await popover.isVisible());
    const open = page.getByTestId("v3-planner-scroll").getByRole("button", { name: "새 세션", exact: true });
    await open.click();
    console.log("승계 열기");
    const modal = page.locator(".v3-succession-modal");
    await modal.waitFor({ state: "visible" });
    await capture(page, modal, "succession", theme, glass, width, height, surfaces);
    interactions.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!interactions.overflow, `${theme} ${glass} ${width}: 가로 스크롤`);
    {
      const disclosure = modal.locator("details").filter({ hasText: "실행 환경" });
      if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
      await modal.getByRole("combobox", { name: "추론 강도 선택" }).click();
      await capture(page, page.locator('[data-slot="select-popup"] .glass:visible'), "select", theme, glass, width, height, surfaces);
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    interactions.successionEscape = !(await modal.isVisible());
    if (width === 1440) {
      await mountAlertSample(page);
      await page.getByRole("button", { name: "폴더 완료", exact: true }).last().click();
      const alert = page.locator('[data-slot="alert-dialog-popup"]:visible');
      await capture(page, alert, "alert", theme, glass, width, height, surfaces);
      await alert.getByRole("button", { name: "취소" }).click();
      await alert.waitFor({ state: "hidden" });
    }
    await captureDocument(browser, theme, glass, width, height, surfaces);
    if (!baseline && !checkboxBefore && glass === "0" && width === 1440) await captureFolderPicker(browser, theme, surfaces);
    console.log("문서 열기 완료");
    return { theme, glass, width, canvas, surfaces, interactions };
  } finally { await context.close(); }
}

async function capture(page: Page, surface: Locator, name: string, theme: string, glass: string, width: number, height: number, results: Record<string, Surface>) {
  await surface.waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  results[name] = await surface.evaluate(el => {
    const style = getComputedStyle(el);
    const color = style.backgroundColor;
    const probe = document.createElement("canvas").getContext("2d")!;
    if (!CSS.supports("color", color)) throw new Error(`유효하지 않은 배경색: ${color}`);
    probe.fillStyle = "#010203"; probe.fillStyle = color;
    const first = probe.fillStyle;
    probe.fillStyle = "#040506"; probe.fillStyle = color;
    if (probe.fillStyle !== first) throw new Error(`배경색 파싱 실패: ${color}`);
    probe.fillRect(0, 0, 1, 1);
    return { background: color, backdrop: style.backdropFilter, alpha: probe.getImageData(0, 0, 1, 1).data[3] / 255 };
  });
  writeFileSync(path.join(output, `${theme}-${glass}-${width}-${name}.json`), JSON.stringify(results[name], null, 2));
  await page.screenshot({ path: path.join(output, `${theme}-${glass}-${width}-${name}.png`), animations: "disabled", timeout: 60_000 });
}

async function captureFolderPicker(browser: Browser, theme: string, surfaces: Record<string, Surface>) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme as "dark" | "light", reducedMotion: "reduce", locale: koreanLocale });
  const page = await context.newPage();
  await page.addInitScript(theme => {
    localStorage.setItem("soul-dashboard-theme", theme);
    localStorage.setItem("ls.webglGlass", "0");
    (window as typeof window & { __name?: unknown }).__name = (f: unknown) => f;
  }, theme);
  await installV3VisualQaRoutes(page, {});
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  try {
    await page.goto(`${baseUrl}/dialogues?sample=card-create`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "폴더 선택", exact: true }).click();
    await capture(page, page.locator('[data-slot="popover-popup"].v3-card-folder-picker:visible'), "card-folder", theme, "0", 1440, 900, surfaces);
  } finally { await context.close(); }
}

async function mountAlertSample(page: Page) {
  const sourcePath = path.resolve("packages/soul-ui/src/folder-status/FolderCompletionAction.tsx");
  await page.evaluate(async (source) => {
    const main = await (await fetch("/client/main.tsx")).text();
    const reactPath = main.match(/"(\/.vite-cache\/deps\/react\.js\?[^\"]+)"/)?.[1];
    const domPath = main.match(/"(\/.vite-cache\/deps\/react-dom_client\.js\?[^\"]+)"/)?.[1];
    if (!reactPath || !domPath) throw new Error("React 검수 모듈을 찾지 못했습니다.");
    const React = (await import(/* @vite-ignore */ reactPath)).default;
    const dom = await import(/* @vite-ignore */ domPath);
    const { FolderCompletionAction } = await import(/* @vite-ignore */ `/@fs${source}`);
    const host = document.createElement("div"); document.body.appendChild(host);
    dom.default.createRoot(host).render(React.createElement(FolderCompletionAction, { task: { id: "qa-folder", title: "운영 점검 폴더", status: "open", version: 1 } }));
  }, sourcePath);
}

async function captureDocument(browser: Browser, theme: string, glass: string, width: number, height: number, surfaces: Record<string, Surface>) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme as "dark" | "light", reducedMotion: "reduce", locale: koreanLocale });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await page.addInitScript(({ theme, glass }) => {
    localStorage.setItem("soul-dashboard-theme", theme); localStorage.setItem("ls.webglGlass", glass);
    localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }));
    (window as typeof window & { __name?: unknown }).__name = (f: unknown) => f;
    const raf = window.requestAnimationFrame.bind(window);
    let glassFrames = 0;
    if (glass === "1") window.requestAnimationFrame = callback => callback.name === "renderFrame" && glassFrames++ > 0 ? 0 : raf(callback);
  }, { theme, glass });
  await installV3VisualQaRoutes(page, { timelineEventCount: 1, timelineContentByEventId: { 1: "[문서 링크](/api/markdown-documents/doc-1)" }, liveEventText: "검수 메시지" });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.com", name: "QA" } } }));
  await page.route("**/api/markdown-documents/doc-1", r => r.fulfill({ json: { id: "doc-1", title: "주간 운영 점검 보고", body: "# 주간 운영 점검 보고\n\n이번 주 예약 작업은 모두 끝났습니다.\n\n마지막 문단입니다.", version: 1, folderId: "rb-alpha" } }));
  const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: false, animate_character: false, show_jev_candidates: true, turn_usage_mode: "collapsed", show_turn_usage: true };
  const session = { session_id: "run-alpha-2", display_name: "내부 링크 검수", node_id: "eiaserinnys", folder_id: "rb-alpha", agent_id: "roselin_codex", agent_name: "로젤린", persistent: true, settings, runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null } };
  await page.route("**/api/persistent-sessions**", route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [session], total: 1, create_defaults: null } });
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions/run-alpha-2") return route.fulfill({ json: { session } });
    return route.fallback();
  });
  try {
    await page.goto(`${baseUrl}/?session=run-alpha-2&event=1`, { waitUntil: "domcontentloaded" });
    if (width === 390) await page.getByTestId("v3-mobile-tab-chat").click();
    await page.locator("a:visible", { hasText: /^문서 링크$/ }).first().click({ timeout: 30_000, force: true });
    await capture(page, page.getByTestId("internal-document-dialog"), "document", theme, glass, width, height, surfaces);
  } finally { await context.close(); }
}

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
