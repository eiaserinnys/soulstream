/**
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43183 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath unified-dashboard/node_modules/@playwright/test/../../playwright/index.mjs) CHROMIUM_PATH=/usr/bin/google-chrome V3_QA_BASE_URL=http://127.0.0.1:43183 V3_SELECTION_QA_OUTPUT=.local/card1583/after node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/v3-dialog-selection.qa.ts
 * Set V3_SELECTION_QA_BASELINE=1 for pre-change captures and measurements.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43183";
const output = path.resolve(process.env.V3_SELECTION_QA_OUTPUT ?? ".local/card1583/after");
const baseline = process.env.V3_SELECTION_QA_BASELINE === "1";
mkdirSync(output, { recursive: true });
const result = await runPlaywrightLifecycle({ lockName: "card1583-dialog-selection", timeoutMs: 180_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const results = [];
  for (const width of [1440, 360]) results.push(await verify(browser, width));
  return results;
});
writeFileSync(path.join(output, "metrics.json"), JSON.stringify({ baseline, result }, null, 2));
console.log(JSON.stringify({ baseline, output, result }, null, 2));

async function verify(browser: Browser, width: number) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, {
    successionPickerRuns: true,
    sessionModelPresets: { "run-alpha-1": "qa-standard", "run-alpha-2": "qa-standard" },
    sessionReasoningEfforts: { "run-alpha-1": "ultra", "run-alpha-2": "ultra" },
  });
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({ json: { model_presets: [
    { id: "qa-standard", label: "QA 표준 모델", backend: "codex", available: true, supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
  ] } }));
  await page.route("**/api/sessions", route => route.request().method() === "POST"
    ? route.fulfill({ status: 500, json: { detail: "연결을 확인할 수 없습니다." } })
    : route.fallback());
  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-starred-task-row-task-alpha").click();
    await page.locator(".v3-run-row").filter({ hasText: "세션 #1" }).first().waitFor({ state: "visible" });
    const projectContext = page.getByTestId("v3-project-context");
    await projectContext.getByRole("button", { name: "atom 추가", exact: true }).click();
    const popover = page.locator('[data-slot="popover-popup"]').filter({ hasText: "atom 노드" });
    const popoverButton = popover.locator("button", { hasText: "노드 선택" });
    await popoverButton.waitFor({ state: "visible" });
    const popoverSelect = await selectionStyle(popoverButton);
    await page.keyboard.press("Escape");
    if (await popover.isVisible()) await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    const open = page.getByTestId("v3-planner-scroll").getByRole("button", { name: "새 세션", exact: true });
    await open.click();
    const modal = page.locator(".v3-succession-modal");
    await modal.waitFor({ state: "visible" });
    const focusOnOpen = await modal.getByRole("textbox", { name: "초기 지시" }).evaluate(el => document.activeElement === el);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });
    const focusOnClose = await open.evaluate(el => document.activeElement === el);
    await open.click();
    await modal.waitFor({ state: "visible" });
    await page.setViewportSize({ width, height: 1000 });
    const disclosure = modal.locator("details").filter({ hasText: "실행 환경" });
    if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
    const notice = modal.getByTestId("succession-effort-unsupported");
    await notice.waitFor({ state: "visible" });
    const defaultButton = modal.getByTestId("succession-effort-use-default");
    const cancel = modal.getByRole("button", { name: "취소", exact: true });
    const input = modal.getByRole("textbox", { name: "초기 지시" });
    await input.fill("시각 검수에서 입력 유지 확인");
    await input.selectText();
    const inputSelection = await input.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    const effort = modal.getByRole("combobox", { name: "추론 강도 선택" });
    await effort.focus();
    await page.keyboard.press("Tab");
    const tabOrder = await defaultButton.evaluate(el => document.activeElement === el);
    await notice.scrollIntoViewIfNeeded();
    const defaultStyle = await selectionStyle(defaultButton);
    const cancelStyle = await selectionStyle(cancel);
    const inputStyle = await selectionStyle(input);
    const selection = await dragThrough(page, notice, cancel);
    await page.screenshot({ path: path.join(output, `succession-${width}.png`), animations: "disabled" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const modalOverflow = await modal.evaluate(el => el.scrollWidth > el.clientWidth);
    await page.setViewportSize({ width: width === 360 ? 1440 : 360, height: 1000 });
    const inputRetained = await input.inputValue();
    await page.setViewportSize({ width, height: 1000 });
    await defaultButton.click();
    await modal.getByRole("button", { name: "세션 시작", exact: true }).click();
    const error = modal.locator(".v3-error-notice strong");
    await error.waitFor({ state: "visible" });
    const retryAvailable = await modal.getByRole("button", { name: "세션 시작", exact: true }).isEnabled();
    const errorStyle = await selectionStyle(error);
    const errorText = await error.textContent();
    const errorBox = await error.boundingBox();
    if (!errorBox) throw new Error("오류 문구 좌표 없음");
    await page.mouse.move(errorBox.x + 2, errorBox.y + errorBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(errorBox.x + errorBox.width - 2, errorBox.y + errorBox.height / 2, { steps: 10 });
    await page.mouse.up();
    const errorSelection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    await page.screenshot({ path: path.join(output, `error-${width}.png`), animations: "disabled" });
    await cancel.click();
    await modal.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "새 폴더", exact: true }).first().click();
    const otherDialog = page.getByRole("dialog", { name: "새 폴더", exact: true });
    const otherDialogStyle = await selectionStyle(otherDialog.getByRole("button", { name: "취소", exact: true }));
    const metrics = { width, selection, defaultStyle, cancelStyle, inputStyle, inputSelection, errorStyle, errorText, errorSelection, retryAvailable, otherDialogStyle, popoverSelect, focusOnOpen, focusOnClose, tabOrder, overflow, modalOverflow, inputRetained };
    if (!baseline) {
      assert(selection.includes("이어받은 추론 강도"), `안내문 선택 실패: ${selection}`);
      assert(!selection.includes("기본값 사용") && !selection.includes("취소"), `단추가 함께 선택됨: ${selection}`);
      assert([defaultStyle, cancelStyle, otherDialogStyle, popoverSelect].every(x => x === "none"), `단추 선택 허용: ${JSON.stringify(metrics)}`);
      assert(inputStyle === "text" && inputSelection === "시각 검수에서 입력 유지 확인" && errorStyle === "text" && errorSelection.includes("세션을 시작하지"), `본문 선택 불가: ${JSON.stringify(metrics)}`);
      assert(focusOnOpen && focusOnClose && tabOrder && !overflow && !modalOverflow && retryAvailable && inputRetained === "시각 검수에서 입력 유지 확인", `조작 검사 실패: ${JSON.stringify(metrics)}`);
    }
    return metrics;
  } finally { await context.close(); }
}
async function selectionStyle(locator: Locator) { return locator.evaluate(el => getComputedStyle(el).userSelect); }
async function dragThrough(page: Page, notice: Locator, cancel: Locator) {
  const start = await notice.boundingBox();
  const end = await cancel.boundingBox();
  if (!start || !end) throw new Error("드래그 좌표 없음");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(start.x + 3, start.y + 8);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
