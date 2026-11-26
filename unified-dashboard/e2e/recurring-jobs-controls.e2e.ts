import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

/**
 * 예약 작업 편집기 일정 컨트롤(반복 주기 select, 매월 날짜 목록, 실행 시각 입력,
 * 실행 일시 입력)의 표면 높이·안쪽 여백·색 구성표·비활성 모양을 잰다.
 *
 *   - 같은 줄의 한 줄 입력 표면 높이가 모두 같다(이름, 시간대, 오프라인, 반복 주기, 실행 일시)
 *   - 실행 시각 입력과 같은 줄의 삭제·시각 추가 단추 높이가 같다
 *   - 매월 날짜 버튼 31개가 7열에 놓이고 좁은 화면을 넘지 않으며 선택을 토글한다
 *   - 실행 시각·실행 일시 입력의 color-scheme이 어두운 바탕(dark)이다
 *   - 1회 작업 편집에서 반복 주기 select가 비활성이고, 비활성 글자색이 soul-ui Input의
 *     비활성 글자색(text-muted-foreground)과 같다
 *
 * 모드별(매월, 고급 cron, 시각 네 개, 1회 편집) 편집기 PNG도 함께 남긴다.
 * 측정값은 RECURRING_LAYOUT_OUT_DIR(없으면 playwright outputDir)에 JSON으로 남긴다.
 * 하나라도 어기면 테스트가 실패한다.
 */

const KOREAN_NAME = "매주 월요일 아침에 지난주 회의록과 이번 주 일정을 정리해서 팀에 공유하는 자동 보고서 작업 ".repeat(3).trim();
const MONTHLY_NAME = "매월 정산 보고";
const ONCE_NAME = "한 번만 실행하는 알림 작업 - ".repeat(6).trim();
const NOW = "2026-11-16T10:00:00.000Z";
const WIDTHS = [1440, 390, 360];
const ONE_LINE_LABELS = ["작업 이름", "시간대", "오프라인 허용 초", "반복 주기"] as const;
const ONCE_ONE_LINE_LABELS = ["작업 이름", "오프라인 허용 초", "반복 주기", "실행 일시"] as const;
const BUTTON_LABELS = ["삭제", "시각 추가"] as const;

test("다른 화면의 실행 대상 비교", async ({ page }) => {
  const outDir = process.env.RECURRING_LAYOUT_OUT_DIR ? path.resolve(process.env.RECURRING_LAYOUT_OUT_DIR) : test.info().outputPath(".");
  mkdirSync(outDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await page.goto("/");
  await page.getByTestId("card-home").getByRole("button", { name: "새 카드", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 카드" });
  await dialog.locator("details").evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await expect(dialog.getByLabel("노드 선택", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(outDir, "card-assignment-1440.png"), animations: "disabled" });
});

function job(jobId: string, name: string, kind: "recurring" | "once", expressions: string[], patch: Record<string, unknown> = {}) {
  return {
    job_id: jobId,
    name,
    prompt: "지난주 기록을 정리해 보고서 초안을 만듭니다.",
    timezone: "Asia/Seoul",
    schedule_kind: kind,
    run_at: kind === "once" ? "2026-11-20T01:00:00.000Z" : null,
    schedule_expressions: expressions,
    node_id: "eiaserinnys",
    agent_id: "roselin",
    model_preset: null,
    folderId: "folder-amber",
    enabled: true,
    archived_at: null,
    late_run_window_seconds: 1800,
    next_run_at: "2026-11-20T01:00:00.000Z",
    version: 3,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

const JOBS = [
  job("job-korean", KOREAN_NAME, "recurring", ["0 9 * * 1-5"]),
  job("job-monthly", MONTHLY_NAME, "recurring", ["0 9 1,15,28 * *"]),
  job("job-once", ONCE_NAME, "once", []),
];

async function installRoutes(page: Page) {
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({
    json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } },
  }));
  // 마지막에 등록한 라우트가 먼저 잡는다. 반복 작업 API만 이 화면의 고정 자료로 답한다.
  await page.route("**/api/recurring-jobs**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { runs: [] } });
    if (url.pathname === "/api/recurring-jobs" && request.method() === "GET") {
      return route.fulfill({ json: { jobs: JOBS } });
    }
    return route.fulfill({ json: { job: JOBS[0] } });
  });
}

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type ControlMeasurement = {
  tag: string;
  type: string | null;
  label: string;
  disabled: boolean;
  rect: Rect;
  surface: Rect | null;
  surfaceHeight: number;
  color: string;
  cursor: string;
  colorScheme: string;
  paddingLeft: number;
  paddingTop: number;
  paddingBottom: number;
  surfaceShadow: string;
};
type StateMeasurement = {
  state: string;
  width: number;
  mutedColor: string;
  controls: ControlMeasurement[];
};

const round = (value: number) => Math.round(value * 10) / 10;

async function measure(page: Page, width: number, state: string): Promise<StateMeasurement> {
  return await page.evaluate((args: { width: number; state: string }) => {
    const { width, state } = args;
    const toRect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        right: Math.round(box.right * 10) / 10,
        bottom: Math.round(box.bottom * 10) / 10,
      };
    };
    const tab = document.querySelector('[data-testid="recurring-jobs-tab"]');
    if (!tab) throw new Error("recurring-jobs-tab not found");
    // 비활성 글자색 기준값은 프로젝트 토큰(text-muted-foreground)을 그대로 재서 쓴다.
    const probe = document.createElement("span");
    probe.className = "text-muted-foreground";
    probe.style.position = "absolute";
    document.body.appendChild(probe);
    const mutedColor = getComputedStyle(probe).color;
    probe.remove();
    const controls: ControlMeasurement[] = [];
    for (const element of tab.querySelectorAll("input, select, textarea, button")) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.offsetParent === null) continue;
      const style = getComputedStyle(element);
      const surface = element.closest('[data-slot="input-control"]');
      const surfaceRect = surface ? toRect(surface) : null;
      const rect = toRect(element);
      controls.push({
        tag: element.tagName,
        type: element.getAttribute("type"),
        label: element.getAttribute("aria-label") ?? (element.textContent ?? "").trim().slice(0, 30),
        disabled: element.hasAttribute("disabled"),
        rect,
        surface: surfaceRect,
        surfaceHeight: surfaceRect ? surfaceRect.height : rect.height,
        color: style.color,
        cursor: style.cursor,
        colorScheme: style.colorScheme,
        paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        surfaceShadow: surface ? getComputedStyle(surface).boxShadow : "",
      });
    }
    return { state, width, mutedColor, controls };
  }, { width, state });
}

function control(measurement: StateMeasurement, label: string) {
  const found = measurement.controls.find((item) => item.label === label);
  if (!found) throw new Error(`${measurement.state}: ${label} 컨트롤을 찾지 못했습니다`);
  return found;
}

const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

async function openRecurringTab(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("v3-global-toolbar")).toBeVisible({ timeout: 60_000 });
  const settingsButton = page.getByRole("button", { name: "설정", exact: true });
  await expect(settingsButton).toBeVisible({ timeout: 60_000 });
  await settingsButton.click();
  const dialog = page.locator(".config-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "반복 작업", exact: true }).click();
  const tab = page.getByTestId("recurring-jobs-tab");
  await expect(tab.getByLabel("작업 이름")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { dialog, tab };
}

for (const width of WIDTHS) {
  test(`일정 컨트롤 표면 ${width}`, async ({ page }) => {
    test.setTimeout(240_000);
    const outDir = process.env.RECURRING_LAYOUT_OUT_DIR
      ? path.resolve(process.env.RECURRING_LAYOUT_OUT_DIR)
      : test.info().outputPath(".");
    mkdirSync(outDir, { recursive: true });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => { localStorage.setItem("ls.webglGlass", "0"); });
    await installRoutes(page);
    const { tab } = await openRecurringTab(page);
    const editor = tab.getByTestId("recurring-schedule-editor");

    const node = tab.getByLabel("노드 선택", { exact: true });
    const agent = tab.getByLabel("에이전트 선택", { exact: true });
    await node.scrollIntoViewIfNeeded();
    const assignment = await node.evaluate(element => {
      const nodeRect = element.getBoundingClientRect();
      const agentRect = document.querySelector('[aria-label="에이전트 선택"]')!.getBoundingClientRect();
      return { nodeHeight: nodeRect.height, agentHeight: agentRect.height };
    });
    await page.screenshot({ path: path.join(outDir, `assignment-${width}.png`), animations: "disabled" });
    writeFileSync(path.join(outDir, `assignment-${width}.json`), JSON.stringify(assignment, null, 2));
    expect(Math.abs(assignment.nodeHeight - assignment.agentHeight)).toBeLessThanOrEqual(1);

    const states: StateMeasurement[] = [];
    const violations: string[] = [];
    const fail = (message: string) => violations.push(message);
    const record = async (state: string, capture?: "editor" | "page") => {
      await settle(page);
      const measurement = await measure(page, width, state);
      states.push(measurement);
      if (capture) {
        await editor.screenshot({ path: path.join(outDir, `editor-${width}-${state}.png`) });
        if (capture === "page") {
          await page.screenshot({ path: path.join(outDir, `capture-${width}-${state}.png`), animations: "disabled" });
        }
      }
      return measurement;
    };

    // 1. 기존 작업(주간) → 매일 모드: 한 줄 입력 표면 높이(이름·시간대·오프라인·반복 주기)와 시각 입력·단추 높이
    await tab.getByRole("button").filter({ hasText: KOREAN_NAME }).first().click();
    await expect(tab.getByLabel("작업 이름")).toHaveValue(KOREAN_NAME);
    await tab.getByLabel("반복 주기").selectOption("daily");
    const daily = await record("daily");

    const oneLineHeights = ONE_LINE_LABELS.map((label) => ({ label, height: control(daily, label).surfaceHeight }));
    const minHeight = Math.min(...oneLineHeights.map((item) => item.height));
    const maxHeight = Math.max(...oneLineHeights.map((item) => item.height));
    if (maxHeight - minHeight > 0.5) {
      fail(`한 줄 입력 표면 높이가 다름: ${oneLineHeights.map((item) => `${item.label} ${round(item.height)}`).join(", ")}`);
    }

    for (let click = 0; click < 3; click += 1) {
      await tab.getByRole("button", { name: "시각 추가" }).click();
    }
    const times4 = await record("times-4", "page");
    const timeHeights = [1, 2, 3, 4].map((index) => control(times4, `실행 시각 ${index}`).surfaceHeight);
    const buttonHeights = BUTTON_LABELS.flatMap((label) => times4.controls.filter((item) => item.tag === "BUTTON" && item.label === label).map((item) => item.rect.height));
    if (buttonHeights.length === 0) fail("삭제·시각 추가 단추를 찾지 못했습니다");
    for (const [index, height] of timeHeights.entries()) {
      for (const buttonHeight of buttonHeights) {
        if (Math.abs(height - buttonHeight) > 0.5) {
          fail(`실행 시각 ${index + 1} 표면 ${round(height)}px와 단추 ${round(buttonHeight)}px 높이가 다름`);
        }
      }
    }
    const timeScheme = control(times4, "실행 시각 1").colorScheme;
    if (!timeScheme.includes("dark")) fail(`실행 시각 color-scheme이 dark가 아님: ${timeScheme}`);

    // 2. 매월 모드: 격자와 토글 상태
    await tab.getByLabel("반복 주기").selectOption("monthly");
    const grid = tab.getByRole("group", { name: "매월 날짜" });
    const days = grid.getByRole("button");
    await expect(days).toHaveCount(31);
    await expect(days.nth(0)).toHaveAttribute("aria-pressed", "true");
    await days.nth(14).click();
    await expect(days.nth(14)).toHaveAttribute("aria-pressed", "true");
    await days.nth(14).click();
    await expect(days.nth(14)).toHaveAttribute("aria-pressed", "false");
    const gridMetrics = await grid.evaluate(element => {
      const editor = element.closest('[data-testid="recurring-schedule-editor"]')!;
      const editorStyle = getComputedStyle(editor);
      return { columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        gridRight: element.getBoundingClientRect().right,
        innerRight: editor.getBoundingClientRect().right - parseFloat(editorStyle.borderRightWidth) - parseFloat(editorStyle.paddingRight),
        documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    writeFileSync(path.join(outDir, `monthly-grid-${width}.json`), JSON.stringify(gridMetrics, null, 2));
    expect(gridMetrics.columns).toBe(7);
    expect(gridMetrics.gridRight).toBeLessThanOrEqual(gridMetrics.innerRight + 1);
    expect(gridMetrics.documentWidth).toBeLessThanOrEqual(gridMetrics.viewportWidth);
    await record("monthly", "page");

    // 3. 기존 매월 작업(1, 15, 28일): 저장된 선택 상태를 확인한다.
    await tab.getByRole("button").filter({ hasText: MONTHLY_NAME }).first().click();
    await expect(tab.getByLabel("반복 주기")).toHaveValue("monthly");
    await record("monthly-existing", "editor");
    for (const day of [1, 15, 28]) await expect(days.nth(day - 1)).toHaveAttribute("aria-pressed", "true");

    // 4. 고급 cron 모드
    await tab.getByLabel("반복 주기").selectOption("advanced");
    await tab.getByLabel("고급 cron").fill("0 9 * * 1-5\n30 18 * * 5\n0 0 1 * *");
    await record("advanced", "editor");

    // 5. 1회 작업 편집: 반복 주기 select 비활성 모양과 실행 일시
    await tab.getByRole("button").filter({ hasText: ONCE_NAME }).first().click();
    await expect(tab.getByLabel("실행 일시")).toBeVisible();
    const once = await record("once-edit", "editor");
    const repeat = control(once, "반복 주기");
    if (!repeat.disabled) fail("1회 작업 편집에서 반복 주기 select가 비활성이 아님");
    if (repeat.color !== once.mutedColor) {
      fail(`비활성 반복 주기 글자색 ${repeat.color}이 text-muted-foreground ${once.mutedColor}와 다름`);
    }
    if (repeat.cursor !== "default") fail(`비활성 반복 주기 커서가 default가 아님: ${repeat.cursor}`);
    const onceHeights = ONCE_ONE_LINE_LABELS.map((label) => ({ label, height: control(once, label).surfaceHeight }));
    const onceMin = Math.min(...onceHeights.map((item) => item.height));
    const onceMax = Math.max(...onceHeights.map((item) => item.height));
    if (onceMax - onceMin > 0.5) {
      fail(`1회 편집 한 줄 입력 표면 높이가 다름: ${onceHeights.map((item) => `${item.label} ${round(item.height)}`).join(", ")}`);
    }
    const runAtScheme = control(once, "실행 일시").colorScheme;
    if (!runAtScheme.includes("dark")) fail(`실행 일시 color-scheme이 dark가 아님: ${runAtScheme}`);

    // 6. 한 줄 컨트롤의 시작 x가 같은 세로줄에 있는지(반복 주기·실행 시각·실행 일시).
    const startX = control(times4, "반복 주기").surface?.x ?? control(times4, "반복 주기").rect.x;
    for (const [state, label] of [["times-4", "실행 시각 1"], ["once-edit", "실행 일시"]] as const) {
      const source = state === "times-4" ? times4 : once;
      const item = control(source, label);
      const x = item.surface?.x ?? item.rect.x;
      if (Math.abs(x - startX) > 0.5) fail(`${label} 시작 x ${round(x)}가 반복 주기 x ${round(startX)}와 다름`);
    }

    writeFileSync(path.join(outDir, `controls-${width}.json`), JSON.stringify({ states, violations }, null, 2));
    expect(violations).toEqual([]);
  });
}
