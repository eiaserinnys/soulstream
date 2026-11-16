import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

/**
 * 예약 작업 편집기(설정 모달 · 반복 작업 탭)의 입력 칸 배치 측정.
 *
 * 폭 1440, 1024, 768, 640, 390, 360에서 새 작업과 기존 작업 편집 두 경우,
 * 시간대 칸이 보이는 일정 모드(매일·평일·매주 요일·매월 날짜·고급 cron)마다
 * 긴 이름(한글 80자 이상, 공백 없는 영문 120자 이상)을 넣고 잰다.
 *
 *   - 같은 행의 필드 컨트롤끼리 사각형이 겹치지 않는다
 *   - 각 컨트롤이 자기 칸(SettingsField label) 안에, 칸이 행 컨테이너 안에 있다(1px 허용)
 *   - 모달 본문에 가로 스크롤이 생기지 않는다
 *
 * 측정값은 RECURRING_LAYOUT_OUT_DIR(없으면 playwright outputDir)에 JSON으로,
 * 캡처는 같은 폴더에 PNG로 남긴다. 하나라도 어기면 테스트가 실패한다.
 */

const KOREAN_LONG_NAME = "매주 월요일 아침에 지난주 회의록과 이번 주 일정을 정리해서 팀에 공유하는 자동 보고서 작업 ".repeat(3).trim();
const ENGLISH_LONG_NAME = "recurring-job-name-without-any-spaces-for-layout-measurement-".repeat(3);
const NOW = "2026-11-16T10:00:00.000Z";
const MODES = ["daily", "weekdays", "weekly", "monthly", "advanced"] as const;
const WIDTHS = [1440, 1024, 768, 640, 390, 360];
const NAMES = { korean: KOREAN_LONG_NAME, english: ENGLISH_LONG_NAME } as const;

type Mode = (typeof MODES)[number];
type NameId = keyof typeof NAMES;

function recurringJob(jobId: string, name: string, expressions: string[]) {
  return {
    job_id: jobId,
    name,
    prompt: "지난주 기록을 정리해 보고서 초안을 만듭니다.",
    timezone: "Asia/Seoul",
    schedule_kind: "recurring",
    run_at: null,
    schedule_expressions: expressions,
    node_id: "eiaserinnys",
    agent_id: "roselin",
    model_preset: null,
    folderId: "folder-amber",
    enabled: true,
    archived_at: null,
    late_run_window_seconds: 1800,
    next_run_at: "2026-11-17T00:00:00.000Z",
    version: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

const JOBS = [
  recurringJob("job-korean", KOREAN_LONG_NAME, ["0 9 * * 1-5"]),
  recurringJob("job-english", ENGLISH_LONG_NAME, ["*/7 * * * *"]),
];

type RouteState = { failJobs: boolean };

async function installRoutes(page: Page, state: RouteState = { failJobs: false }) {
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
    if (state.failJobs) {
      return route.fulfill({ status: 500, json: { detail: { error: { message: "예약 작업을 불러오지 못했습니다" } } } });
    }
    if (url.pathname === "/api/recurring-jobs" && request.method() === "GET") {
      return route.fulfill({ json: { jobs: JOBS } });
    }
    return route.fulfill({ json: { job: JOBS[0] } });
  });
  return state;
}

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type FieldRect = { labelText: string; controlLabel: string | null; label: Rect; control: Rect | null };
type Measurement = {
  width: number;
  angle: "new" | "edit";
  nameId: NameId;
  mode: Mode;
  row: Rect;
  fields: FieldRect[];
  scrollers: Array<{ name: string; scrollWidth: number; clientWidth: number }>;
  header: { title: Rect | null; actions: Rect | null };
};

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
}

async function measure(page: Page, width: number, angle: "new" | "edit", nameId: NameId, mode: Mode): Promise<Measurement> {
  const data = await page.evaluate(() => {
    const toRect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const tab = document.querySelector('[data-testid="recurring-jobs-tab"]');
    if (!tab) throw new Error("recurring-jobs-tab not found");
    const nameInput = tab.querySelector('input[aria-label="작업 이름"]');
    if (!nameInput) throw new Error("작업 이름 input not found");
    const field = nameInput.closest("label");
    if (!field) throw new Error("SettingsField label not found");
    const row = field.parentElement;
    if (!row) throw new Error("field row not found");
    const fields = [...row.children]
      .filter((child) => child.tagName === "LABEL")
      .map((label) => {
        const control = label.querySelector("input, select, textarea");
        return {
          labelText: (label.querySelector("span")?.textContent ?? "").trim(),
          controlLabel: control?.getAttribute("aria-label") ?? null,
          label: toRect(label),
          control: control ? toRect(control) : null,
        };
      });
    const scroller = (name: string, element: Element | null) => ({
      name,
      scrollWidth: element ? element.scrollWidth : 0,
      clientWidth: element ? element.clientWidth : 0,
    });
    const headerTitle = tab.querySelector("header h3");
    const headerActions = tab.querySelector("header > div:last-child");
    return {
      row: toRect(row),
      fields,
      scrollers: [
        scroller("dialog-panel-scroll", document.querySelector('.config-dialog [data-slot="dialog-panel-scroll"]')),
        scroller("config-detail", document.querySelector(".config-dialog .config-detail")),
        scroller("settings-detail-column", field.parentElement?.parentElement ?? null),
        scroller("recurring-jobs-tab", tab),
        scroller("document", document.scrollingElement),
      ],
      header: {
        title: headerTitle ? toRect(headerTitle) : null,
        actions: headerActions ? toRect(headerActions) : null,
      },
    };
  });
  return { width, angle, nameId, mode, ...data };
}

function overlaps(first: Rect, second: Rect): boolean {
  return Math.min(first.right, second.right) - Math.max(first.x, second.x) > 0.5
    && Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y) > 0.5;
}

function outside(inner: Rect, outer: Rect, tolerance = 1): boolean {
  return inner.x < outer.x - tolerance
    || inner.y < outer.y - tolerance
    || inner.right > outer.right + tolerance
    || inner.bottom > outer.bottom + tolerance;
}

const round = (value: number) => Math.round(value * 10) / 10;

function violationsOf(measurement: Measurement): string[] {
  const found: string[] = [];
  const bounds = measurement.row;
  const rows: FieldRect[][] = [];
  for (const field of measurement.fields) {
    const group = rows.find((candidate) => Math.abs(candidate[0].label.y - field.label.y) <= 1.5);
    if (group) group.push(field);
    else rows.push([field]);
  }
  for (const group of rows) {
    const controls = group.filter((field) => field.control !== null);
    for (let index = 0; index < controls.length; index += 1) {
      for (let other = index + 1; other < controls.length; other += 1) {
        const left = controls[index];
        const right = controls[other];
        if (overlaps(left.control as Rect, right.control as Rect)) {
          found.push(`필드 컨트롤 겹침: ${left.controlLabel} ↔ ${right.controlLabel}`);
        }
      }
    }
  }
  for (const field of measurement.fields) {
    if (field.control && outside(field.control, field.label)) {
      found.push(`컨트롤이 자기 칸을 넘음: ${field.controlLabel} (칸 ${round(field.label.x)}~${round(field.label.right)}, 컨트롤 ${round(field.control.x)}~${round(field.control.right)})`);
    }
    if (outside(field.label, bounds)) {
      found.push(`칸이 행 컨테이너를 넘음: ${field.labelText || field.controlLabel} (행 ${round(bounds.x)}~${round(bounds.right)}, 칸 ${round(field.label.x)}~${round(field.label.right)})`);
    }
  }
  for (const scroller of measurement.scrollers) {
    if (scroller.scrollWidth - scroller.clientWidth > 1) {
      found.push(`가로 스크롤: ${scroller.name} (${scroller.scrollWidth} > ${scroller.clientWidth})`);
    }
  }
  return found;
}

const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

async function openRecurringTab(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("v3-global-toolbar")).toBeVisible({ timeout: 60_000 });
  const settingsButton = page.getByRole("button", { name: "서버 설정", exact: true });
  await expect(settingsButton).toBeVisible({ timeout: 60_000 });
  await settingsButton.click();
  const dialog = page.locator(".config-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "반복 작업", exact: true }).click();
  const tab = page.getByTestId("recurring-jobs-tab");
  await expect(tab).toBeVisible();
  await expect(tab.getByLabel("작업 이름")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { dialog, tab, settingsButton };
}

async function activeInfo(page: Page) {
  return await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return {
      tag: element?.tagName ?? null,
      label: (element?.getAttribute("aria-label") || element?.textContent || "").trim().slice(0, 60),
      inDialog: Boolean(element?.closest(".config-dialog")),
      visible: element ? element.offsetParent !== null : false,
    };
  });
}

for (const width of WIDTHS) {
  test(`예약 작업 편집기 입력 칸 배치 ${width}`, async ({ page }) => {
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

    const violations: string[] = [];
    const capture = async (name: string) => {
      await page.screenshot({ path: path.join(outDir, `${name}.png`), animations: "disabled" });
    };

    for (const angle of ["new", "edit"] as const) {
      for (const nameId of Object.keys(NAMES) as NameId[]) {
        if (angle === "new") {
          await tab.getByRole("button", { name: "새 작업", exact: true }).click();
          await tab.getByLabel("작업 이름").fill(NAMES[nameId]);
        } else {
          await tab.getByRole("button").filter({ hasText: NAMES[nameId] }).first().click();
          await expect(tab.getByLabel("작업 이름")).toHaveValue(NAMES[nameId]);
        }
        for (const mode of MODES) {
          await tab.getByLabel("반복 주기").selectOption(mode);
          await expect(tab.getByLabel("시간대")).toBeVisible();
          await settle(page);
          const measurement = await measure(page, width, angle, nameId, mode);
          const tag = `폭 ${width} / ${angle === "new" ? "새 작업" : "기존 작업 편집"} / ${mode} / ${nameId === "korean" ? "한글" : "영문"}`;
          writeFileSync(
            path.join(outDir, `measure-${width}-${angle}-${nameId}-${mode}.json`),
            JSON.stringify({ tag, ...measurement }, null, 2),
          );
          const found = violationsOf(measurement);
          if (mode === "weekdays") await capture(`shot-${width}-${angle}-${nameId}-${mode}`);
          if (found.length > 0) {
            await capture(`fail-${width}-${angle}-${nameId}-${mode}`);
            violations.push(`${tag}: ${found.join("; ")}`);
          }
        }
      }
    }
    expect(violations, `입력 칸 배치 위반\n${violations.join("\n")}`).toEqual([]);
  });
}

/**
 * ui-design 0절의 조작 항목(14~18) 가운데 이 화면에 해당하는 것을 같은 실행에서 잰다.
 * 판정은 JSON과 콘솔 출력으로 남기고, 배치 합격 기준(위 테스트)만 실패로 만든다.
 * 16번(최소 폭 넘침)은 위 폭별 테스트가 360px까지 직접 잰다.
 */
test("예약 작업 편집기 조작 항목", async ({ page }) => {
  test.setTimeout(180_000);
  const outDir = process.env.RECURRING_LAYOUT_OUT_DIR
    ? path.resolve(process.env.RECURRING_LAYOUT_OUT_DIR)
    : test.info().outputPath(".");
  mkdirSync(outDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("ls.webglGlass", "0"); });
  const routeState = await installRoutes(page);

  const openedAt = Date.now();
  const { dialog, tab, settingsButton } = await openRecurringTab(page);
  const openedFocus = await activeInfo(page);

  // 14. 누른 뒤 초점: 탭을 누른 뒤에도 초점이 대화상자 안에 남는다.
  await tab.getByRole("button", { name: "새 작업", exact: true }).click();
  await tab.getByLabel("작업 이름").fill(NAMES.korean);
  const afterClickFocus = await activeInfo(page);

  // 15. Tab: 대화상자 안에서만 이동하고, 보이지 않는 요소에 들어가지 않는다. Esc로 닫힌다.
  const tabStops: Array<{ step: number; info: Awaited<ReturnType<typeof activeInfo>> }> = [];
  for (let step = 1; step <= 8; step += 1) {
    await page.keyboard.press("Tab");
    tabStops.push({ step, info: await activeInfo(page) });
  }

  // 17. 오류 상태: 실패하면 그 자리에 안내가 서고, 새로고침으로 다시 시도할 수 있다.
  routeState.failJobs = true;
  await tab.getByTestId("recurring-jobs-refresh").click();
  const errorAlert = tab.getByRole("alert");
  await expect(errorAlert).toBeVisible();
  const errorText = (await errorAlert.textContent())?.trim() ?? "";
  await page.screenshot({ path: path.join(outDir, "interaction-error.png"), animations: "disabled" });
  routeState.failJobs = false;
  await tab.getByTestId("recurring-jobs-refresh").click();
  await expect(tab.getByRole("button").filter({ hasText: NAMES.korean }).first()).toBeVisible();
  const alertStillVisible = await errorAlert.isVisible().catch(() => false);

  // 18. 창 크기 바꾸기: 넓은 폭 → 좁은 폭 → 다시 넓은 폭에서 배치가 다시 서고 입력이 남는다.
  const resize: Array<{ width: number; violations: string[]; nameValue: string; dialogFits: boolean }> = [];
  for (const nextWidth of [640, 1440]) {
    await page.setViewportSize({ width: nextWidth, height: 1000 });
    await settle(page);
    const measurement = await measure(page, nextWidth, "new", "korean", "weekdays");
    const box = await dialog.boundingBox();
    resize.push({
      width: nextWidth,
      violations: violationsOf(measurement),
      nameValue: await tab.getByLabel("작업 이름").inputValue(),
      dialogFits: Boolean(box && box.x >= 0 && box.x + box.width <= nextWidth),
    });
  }

  // 15(닫기)와 14(초점 복귀): Esc로 닫고 초점이 연 버튼으로 돌아온다.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const closedFocus = await activeInfo(page);
  const focusRestored = await settingsButton.evaluate((element) => document.activeElement === element);

  const report = {
    openedAt,
    openedFocus,
    afterClickFocus,
    tabStops,
    errorText,
    alertStillVisibleAfterRecovery: alertStillVisible,
    resize,
    closedFocus,
    focusRestoredToTrigger: focusRestored,
  };
  writeFileSync(path.join(outDir, "interaction.json"), JSON.stringify(report, null, 2));
  console.log(`조작 항목 측정: ${JSON.stringify(report)}`);

  expect(errorText).toContain("예약 작업을 불러오지 못했습니다");
  expect(resize.every((entry) => entry.violations.length === 0)).toBe(true);
  expect(resize.every((entry) => entry.nameValue === NAMES.korean)).toBe(true);
  expect(resize.every((entry) => entry.dialogFits)).toBe(true);
  expect(tabStops.every((entry) => entry.info.inDialog && entry.info.visible)).toBe(true);
  expect(focusRestored).toBe(true);
});
