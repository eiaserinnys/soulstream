/**
 * VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43183 --strictPort
 * PLAYWRIGHT_MODULE=$(realpath unified-dashboard/node_modules/@playwright/test/../../playwright/index.mjs) CHROMIUM_PATH=/usr/bin/google-chrome V3_QA_BASE_URL=http://127.0.0.1:43183 V3_SELECTION_QA_OUTPUT=.local/card1583/after node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/v3-dialog-selection.qa.ts
 * Set V3_SELECTION_QA_BASELINE=1 for pre-change captures and measurements.
 */
import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { reviewCard, reviewDetail } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43183";
const output = path.resolve(process.env.V3_SELECTION_QA_OUTPUT ?? ".local/card1583/after");
const baseline = process.env.V3_SELECTION_QA_BASELINE === "1";
mkdirSync(output, { recursive: true });
const docBody = "# 주간 운영 점검 보고\n\n이번 주 예약 작업 여섯 건은 모두 제시간에 끝났습니다.\n\n> 인용한 운영 메모입니다.\n\n```bash\ndf -h /home\n```\n\n마지막 문단입니다.";
const messageMarkdown = ["[문서 링크](/api/markdown-documents/doc-1)", "[없는 문서](/api/markdown-documents/missing-doc)"].join("\n\n");




const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_models: [],
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed" as const,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: "run-alpha-2",
  display_name: "내부 링크 검수",
  node_id: "eiaserinnys",
  folder_id: "rb-alpha",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};

const result = await runPlaywrightLifecycle({ lockName: "card1583-dialog-selection", timeoutMs: 600_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const results = [];
  for (const width of [1440, 360]) {
    const cases = { verify, documentReader, attachment, usageLog, statusPicker };
    for (const [name, run] of Object.entries(cases)) {
      // Cross-column copying needs the table columns on screen; narrow coverage uses the other surfaces.
      if (name === "usageLog" && width === 360) continue;
      if (!process.env.V3_SELECTION_QA_ONLY || process.env.V3_SELECTION_QA_ONLY === name) {
        console.log(`검수: ${name} ${width}`);
        results.push({ name, width, metrics: await run(browser, width) });
      }
    }
  }
  return results;
});
writeFileSync(path.join(output, "metrics.json"), JSON.stringify({ baseline, result }, null, 2));
console.log(JSON.stringify({ baseline, output, result }, null, 2));

async function verify(browser: Browser, width: number) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
  await context.addInitScript({ content: "window.__name = (f) => f;" });
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
    await page.setViewportSize({ width: 360, height: 1000 });
    await waitForPopupToSettle(popover);
    const popupBox = await popover.boundingBox();
    const popupInViewport = popupBox === null || (popupBox.x >= 0 && popupBox.x + popupBox.width <= 361);
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    const scrollPanel = modal.locator('[data-slot="dialog-panel-scroll"]');
    const scrollBefore = await scrollPanel.evaluate(el => el.scrollTop);
    await page.setViewportSize({ width: width === 360 ? 1440 : 360, height: 1000 });
    const inputRetained = await input.inputValue();
    await page.setViewportSize({ width, height: 1000 });
    const scrollAfter = await scrollPanel.evaluate(el => el.scrollTop);
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
    const errorSelection = await copied(page);
    await page.screenshot({ path: path.join(output, `error-${width}.png`), animations: "disabled" });
    await cancel.click();
    await modal.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "새 폴더", exact: true }).first().click();
    const otherDialog = page.getByRole("dialog", { name: "새 폴더", exact: true });
    const otherDialogStyle = await selectionStyle(otherDialog.getByRole("button", { name: "취소", exact: true }));
    const metrics = { width, selection, defaultStyle, cancelStyle, inputStyle, inputSelection, errorStyle, errorText, errorSelection, retryAvailable, otherDialogStyle, popoverSelect, popupInViewport, focusOnOpen, focusOnClose, tabOrder, overflow, modalOverflow, inputRetained, scrollBefore, scrollAfter };
    if (!baseline) {
      assert(selection.includes("이어받은 추론 강도"), `안내문 선택 실패: ${selection}`);
      assert(!selection.includes("기본값 사용") && !selection.includes("취소"), `단추가 함께 선택됨: ${selection}`);
      assert([defaultStyle, cancelStyle, otherDialogStyle, popoverSelect].every(x => x === "none"), `단추 선택 허용: ${JSON.stringify(metrics)}`);
      assert(inputStyle === "text" && inputSelection === "시각 검수에서 입력 유지 확인" && errorStyle === "text" && errorSelection.includes("세션을 시작하지"), `본문 선택 불가: ${JSON.stringify(metrics)}`);
      assert(popupInViewport, "크기 변경 뒤 팝오버가 화면 밖에 있음");
      assert(focusOnOpen && focusOnClose && tabOrder && !overflow && !modalOverflow && retryAvailable && inputRetained === "시각 검수에서 입력 유지 확인" && Math.abs(scrollAfter - scrollBefore) <= 1, `대화상자 조작 검사 실패: ${JSON.stringify(metrics)}`);
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
  return copied(page);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function waitForPopupToSettle(popup: Locator) {
  await popup.evaluate(el => new Promise<void>((resolve, reject) => {
    const start = performance.now(); let last = ""; let stable = 0;
    const check = () => {
      const r = el.getBoundingClientRect(); const key = [r.x,r.y,r.width,r.height].join(",");
      stable = key === last ? stable + 1 : 0; last = key;
      if (performance.now() - start >= 400 && stable >= 3 && r.x >= 0 && r.right <= innerWidth + 1) resolve();
      // 폭을 바꾼 직후 팝오버 재배치가 1,000ms를 넘기는 경우가 있다(카드 #1651 실측).
      else if (performance.now() - start >= 5000) reject(new Error("팝오버 위치 안정화 시간 초과"));
      else requestAnimationFrame(check);
    }; requestAnimationFrame(check);
  }));
}
async function ctx(browser: Browser, width: number) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width, height: width < 500 ? 844 : 1000 }, reducedMotion: "reduce", timezoneId: "Asia/Seoul", colorScheme: "dark" });
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    const sw = navigator.serviceWorker;
    if (sw) Object.defineProperty(sw, "register", { configurable: true, value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined }) });
  });
  return { context, page };
}
function sel(page: Page) { return page.evaluate(() => window.getSelection()?.toString() ?? ""); }
function clear(page: Page) { return page.evaluate(() => window.getSelection()?.removeAllRanges()); }
function us(l: Locator) { return l.evaluate(el => getComputedStyle(el).userSelect); }
async function drag(page: Page, from: Locator, to: Locator, fromAt: "start" | "center" | "edge" = "start", toAt: "center" | "end" = "center") {
  const a = await from.boundingBox(); const b = await to.boundingBox();
  if (!a || !b) throw new Error("drag box missing");
  await clear(page);
  // 제목 첫 글자 경계는 폰트 크기에 따라 상자 왼쪽에서 1~2px 안쪽이다. +2는 20px 글꼴의
  // 첫 글자(예: "주")를 지나쳐 선택에서 빠뜨렸다(카드 #1651 실측). +1이 두 폭 모두 안전하다.
  await page.mouse.move(fromAt === "edge" ? a.x - 1 : fromAt === "start" ? a.x + 1 : a.x + a.width / 2, fromAt === "start" ? a.y + Math.min(8, a.height / 2) : a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + (toAt === "end" ? b.width - 2 : b.width / 2), b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
  return sel(page);
}
async function copied(page: Page) {
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("Control+C");
  return page.evaluate(() => navigator.clipboard.readText());
}
async function dbl(page: Page, l: Locator) { await clear(page); await l.dblclick(); return sel(page); }
async function triple(page: Page, l: Locator) { await clear(page); await l.click({ clickCount: 3 }); return sel(page); }
async function chatPage(browser: Browser, width: number) {
  const c = await ctx(browser, width);
  const { page } = c;
  await page.addInitScript(() => localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" })));
  await installV3VisualQaRoutes(page, { timelineEventCount: 1, timelineContentByEventId: { 1: messageMarkdown }, liveEventText: "검수 메시지" });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.com", name: "QA" } } }));
  await page.route(u => new URL(u).pathname.startsWith("/api/markdown-documents/"), r => {
    const id = new URL(r.request().url()).pathname.split("/").at(-1)!;
    if (id === "missing-doc") return r.fulfill({ status: 500, json: { error: "missing" } });
    return r.fulfill({ json: { id, title: "주간 운영 점검 보고", body: docBody, version: 1, folderId: "rb-alpha" } });
  });
  await page.route("**/api/persistent-sessions**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
    if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions/run-alpha-2") return route.fulfill({ json: { session: persistentSession } });
    return route.fallback();
  });
  await page.goto(`${baseUrl}/?session=run-alpha-2&event=1`, { waitUntil: "domcontentloaded" });
  await page.locator("a:visible", { hasText: "문서 링크" }).first().waitFor({ state: "visible", timeout: 30_000 });
  return c;
}

async function documentReader(browser: Browser, width: number) {
  const { context, page } = await chatPage(browser, 1440);
  try {
    await page.locator("a:visible", { hasText: /^문서 링크$/ }).first().click();
    const dialog = page.getByTestId("internal-document-dialog");
    await dialog.waitFor({ state: "visible" });
    const body = dialog.locator(".v3-folder-board-document-copy");
    await body.waitFor({ state: "visible" });
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await page.waitForTimeout(300);
    const title = dialog.locator('[data-slot="dialog-title"]');
    const close = dialog.getByRole("button", { name: "문서 닫기" });
    const m: Record<string, unknown> = {};
    m.titleText = await title.textContent();
    m.titleUS = await us(title);
    m.bodyUS = await us(body.locator("p").first());
    m.codeUS = await us(body.locator("pre, code").first());
    m.bodyButtons = await body.locator("button").evaluateAll(bs => bs.map(b => ({ label: b.getAttribute("aria-label") ?? b.textContent, us: getComputedStyle(b).userSelect, text: (b.textContent ?? "").trim() })));
    m.closeUS = await us(close);
    m.dragTitleToBodyEnd = await drag(page, title, body.locator("p").last(), "start", "end");
    await page.screenshot({ path: path.join(output, `document-drag-${width}.png`) });
    m.forwardCopied = await copied(page);
    console.log("문서 정방향", JSON.stringify(m));
    m.reverseCopied = await dragUp(page, body.locator("p").last(), title);
    assert(String(m.forwardCopied).includes("주간 운영 점검 보고") && String(m.forwardCopied).includes("마지막 문단"), "문서 제목→본문 복사 실패: " + JSON.stringify(m));
    assert(String(m.reverseCopied).includes("주간 운영 점검 보고"), "문서 본문→제목 복사 실패: " + JSON.stringify(m));
    m.dragBodyToClose = await drag(page, body.locator("p").first(), close, "start");
    m.dragBodyToCloseCopied = await copied(page);
    m.tripleTitle = await triple(page, title);
    await page.screenshot({ path: path.join(output, `document-${width}.png`) });
    await drag(page, title, body.locator("p").last(), "start", "end");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.locator("a:visible", { hasText: "없는 문서" }).first().click();
    await dialog.waitFor({ state: "visible" });
    const err = dialog.locator('[data-slot="frame-notice"] p');
    await err.waitFor({ state: "visible" });
    m.errorText = await err.textContent();
    m.errorUS = await us(err);
    return m;
  } finally { await context.close(); }
}

async function attachment(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width);
  try {
    await installV3VisualQaRoutes(page, {});
    await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
    await page.goto(`${baseUrl}/dialogues?sample=chat-attachments`, { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: /톤 제안 원문\.md/ }).first();
    await trigger.waitFor({ state: "visible", timeout: 30_000 });
    await trigger.click();
    const dialog = page.locator('[data-slot="dialog-popup"]').filter({ has: page.locator('[data-slot="attachment-preview-body"]') });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const body = dialog.locator('[data-slot="attachment-preview-body"]');
    await page.waitForTimeout(500);
    const m: Record<string, unknown> = {};
    const title = dialog.getByRole("heading").first();
    m.titleText = await title.textContent().catch(() => null);
    m.titleUS = await us(title).catch(() => null);
    await title.dblclick({ position: { x: 3, y: 10 } });
    m.titleCopied = await copied(page);
    assert(m.titleUS === "text" && String(m.titleCopied).includes("톤"), "첨부 파일명 선택 실패");
    m.bodyUS = await us(body.locator("p").first());
    m.codeUS = await us(body.locator("pre").first()).catch(() => null);
    m.buttons = await dialog.locator("button").evaluateAll(bs => bs.map(b => ({ label: b.getAttribute("aria-label") ?? "", text: (b.textContent ?? "").trim(), us: getComputedStyle(b).userSelect, inBody: !!b.closest('[data-slot="attachment-preview-body"]') })));
    m.dragBody = await drag(page, body.locator("h1, h2, p").first(), body.locator("pre").first(), "start");
    m.dragBodyCopied = await copied(page);
    const footerBtn = dialog.locator('[data-slot="dialog-footer"] button').first();
    if (await footerBtn.count()) { m.dragBodyToFooter = await drag(page, body.locator("p").first(), footerBtn, "start"); m.dragBodyToFooterCopied = await copied(page); }
    const bq = body.locator('button[aria-label="인용문 복사"], button[aria-label="코드 복사"]').first();
    if (await bq.count()) m.dblCopyBtn = await dbl(page, bq);
    await drag(page, body.locator("h1, h2, p").first(), body.locator("pre").first(), "start");
    await page.screenshot({ path: path.join(output, `attachment-${width}.png`) });
    return m;
  } finally { await context.close(); }
}

async function usageLog(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width);
  try {
    await installV3VisualQaRoutes(page, {});
    const ev = (i: number) => ({ eventId: `ev-${i}`, occurredAt: `2026-07-28T0${i}:15:00+09:00`, installId: "inst-qa-7f3a", clientKind: "web", clientSessionKey: "k", appVersion: "1.2.3", type: "compose_result", target: { kind: "session", id: "run-alpha-1-abcdef" }, from: null, entry: "planner", flowId: null, attrs: { status: "failed", code: "ECONNRESET" } });
    await page.route("**/api/ui-events/installs**", r => r.fulfill({ json: { installs: [] } }));
    await page.route(u => new URL(u).pathname === "/api/ui-events", r => r.fulfill({ json: { events: [ev(1), ev(2), ev(3)] } }));
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const opener = page.locator('button[aria-label="Open server configuration"]:visible, button[aria-label="설정"]:visible, [data-testid="config-button"]:visible').first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();
    const dialog = page.locator('[data-slot="dialog-popup"]').first();
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("nav button, [role=tab]").filter({ hasText: "사용 로그" }).first().click();
    const row = dialog.locator("tbody tr").first();
    await row.waitFor({ state: "visible", timeout: 10_000 });
    const m: Record<string, unknown> = {};
    m.cells = await row.locator("td").evaluateAll(tds => tds.map(td => ({ text: (td.textContent ?? "").trim(), us: getComputedStyle(td).userSelect })));
    m.dragRow = await drag(page, row.locator("td").first(), row.locator("td").last(), "start");
    m.dragRowCopied = await copied(page);
    assert(String(m.dragRowCopied).includes("1:15") && String(m.dragRowCopied).includes("전송 결과") && !String(m.dragRowCopied).includes("session:run-alph"), "사용 로그 행 복사 실패: " + m.dragRowCopied);
    await page.screenshot({ path: path.join(output, `usage-log-${width}.png`) });
    return m;
  } finally { await context.close(); }
}

async function statusPicker(browser: Browser, width: number) {
  const { context, page } = await ctx(browser, width);
  try {
    const card = { ...reviewCard, id: "card-select-qa", folderId: "folder-amber", title: "글자 선택 검수 카드", status: "review", assigneeSessionId: "run-alpha-1", color: "yellow", version: 1 };
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, postitCards: [card] });
    let fail = true;
    await page.route(/\/api\/cards\/card-select-qa(?:\/.*)?$/, r => fail ? r.fulfill({ status: 500, json: { error: "card store unavailable: ETIMEDOUT" } }) : r.fulfill({ json: { ...reviewDetail, card, reports: [], comments: [], questions: [], sessions: [] } }));
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const paper = page.locator('article.v3-postit-card[data-card-id="card-select-qa"]');
    await paper.waitFor({ state: "visible", timeout: 30_000 });
    await paper.getByRole("button", { name: "카드 상태 변경" }).click();
    const picker = page.locator("[data-card-status-picker][data-open]");
    await picker.waitFor({ state: "visible" });
    await page.waitForTimeout(800);
    const m: Record<string, unknown> = {};
    m.buttons = await picker.locator("button").evaluateAll(bs => bs.map(b => ({ text: (b.textContent ?? "").trim(), us: getComputedStyle(b).userSelect })));
    m.paras = await picker.locator("p").evaluateAll(ps => ps.map(p => ({ text: (p.textContent ?? "").trim(), us: getComputedStyle(p).userSelect })));
    const errP = picker.locator("p[role=alert], p[role=status]").first();
    const firstRow = picker.locator('[aria-label="카드 상태 목록"] button').first();
    if (await errP.count()) {
      m.dragErrorToRows = await drag(page, errP, picker.locator("button").last(), "start");
      m.dragErrorToRowsCopied = await copied(page);
      assert(String(m.dragErrorToRowsCopied).includes((await errP.textContent())!.trim()) && !(await picker.locator("button").allTextContents()).some(text => text.trim() && String(m.dragErrorToRowsCopied).includes(text.trim())), "상태 선택 단추 복사 차단 실패");
      m.dragErrorToFirstRow = await drag(page, errP, picker.locator("button").nth(1), "start");
      m.dragErrorToFirstRowCopied = await copied(page);
      await page.screenshot({ path: path.join(output, `status-picker-drag-${width}.png`) });
    }
    if (await firstRow.count()) m.dblRowUS = await us(firstRow);
    const box = await picker.boundingBox();
    m.pickerBox = box; m.viewport = page.viewportSize();
    await page.screenshot({ path: path.join(output, `status-picker-${width}.png`) });
    return m;
  } finally { await context.close(); }
}

async function dragUp(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox(); const b = await to.boundingBox();
  if (!a || !b) throw new Error("box");
  await clear(page);
  await page.mouse.move(a.x + a.width - 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x - 1, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
  return copied(page);
}
