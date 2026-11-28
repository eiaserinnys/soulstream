import { expect, test, type Locator, type Page } from "./test";
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
 * 여기에 더해 1회 실행 모드(시간대 칸이 빠지는 배치)와, 이름·시간대 칸에 초점이 간
 * 상태의 초점 고리(자기 칸에서 얼마나 나가고 이웃 칸에 닿는가)를 같은 방식으로 잰다.
 * 초점 고리는 프로젝트 입력 표면(span[data-slot=input-control])의 box-shadow로 그려진다.
 *
 * 측정값은 RECURRING_LAYOUT_OUT_DIR(없으면 playwright outputDir)에 JSON으로,
 * 캡처는 같은 폴더에 PNG로 남긴다. 하나라도 어기면 테스트가 실패한다.
 */

const KOREAN_LONG_NAME = "매주 월요일 아침에 지난주 회의록과 이번 주 일정을 정리해서 팀에 공유하는 자동 보고서 작업 ".repeat(3).trim();
const ENGLISH_LONG_NAME = "recurring-job-name-without-any-spaces-for-layout-measurement-".repeat(3);
const ONCE_LONG_NAME = "한 번만 실행하는 알림 작업 - ".repeat(6).trim();
const NOW = "2026-11-16T10:00:00.000Z";
const MODES = ["daily", "weekdays", "weekly", "monthly", "advanced"] as const;
const WIDTHS = [1440, 1024, 768, 640, 390, 360];
const ONCE_WIDTHS = [1440, 1024, 768, 390];
const FOCUS_WIDTHS = [1440, 768, 390];
const NAMES = { korean: KOREAN_LONG_NAME, english: ENGLISH_LONG_NAME } as const;

type Mode = (typeof MODES)[number];
type ScheduleMode = Mode | "once";
type NameId = keyof typeof NAMES;
type MeasurementNameId = NameId | "once";

function recurringJob(jobId: string, name: string, expressions: string[], patch: Record<string, unknown> = {}) {
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
    ...patch,
  };
}

const JOBS = [
  recurringJob("job-korean", KOREAN_LONG_NAME, ["0 9 * * 1-5"]),
  recurringJob("job-english", ENGLISH_LONG_NAME, ["*/7 * * * *"]),
  recurringJob("job-once", ONCE_LONG_NAME, [], {
    schedule_kind: "once",
    run_at: "2026-11-20T01:00:00.000Z",
    next_run_at: "2026-11-20T01:00:00.000Z",
  }),
];

type RouteState = { failJobs: boolean; listGate?: Promise<void>; failSave?: boolean; saveGate?: Promise<void> };

async function installRoutes(page: Page, state: RouteState = { failJobs: false }) {
  let created: ReturnType<typeof recurringJob> | undefined;
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({
    json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } },
  }));
  // 마지막에 등록한 라우트가 먼저 잡는다. 반복 작업 API만 이 화면의 고정 자료로 답한다.
  await page.route("**/api/recurring-jobs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { runs: [] } });
    if (state.failJobs) {
      return route.fulfill({ status: 500, json: { detail: { error: { message: "예약 작업을 불러오지 못했습니다" } } } });
    }
    if (url.pathname === "/api/recurring-jobs" && request.method() === "GET") {
      await state.listGate;
      return route.fulfill({ json: { jobs: created ? [created, ...JOBS] : JOBS } });
    }
    if ((url.pathname === "/api/recurring-jobs" && request.method() === "POST") || (url.pathname.startsWith("/api/recurring-jobs/") && request.method() === "PATCH")) {
      await state.saveGate;
      if (state.failSave) return route.fulfill({ status: 500, json: { detail: "저장하지 못했습니다" } });
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (!body.name || !body.prompt || !body.node_id || !body.agent_id || !body.folderId) return route.fulfill({ status: 400, json: { detail: "필수 항목을 입력하세요" } });
        created = recurringJob("created-job", body.name, body.schedule_expressions, body);
        return route.fulfill({ json: { job: created } });
      }
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
  nameId: MeasurementNameId;
  mode: ScheduleMode;
  row: Rect;
  fields: FieldRect[];
  scrollers: Array<{ name: string; scrollWidth: number; clientWidth: number; overflowX: string }>;
  header: { title: Rect | null; actions: Rect | null };
};

async function measure(page: Page, width: number, angle: "new" | "edit", nameId: MeasurementNameId, mode: ScheduleMode): Promise<Measurement> {
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
    // 입력 칸의 사각형은 프로젝트 입력 표면(span[data-slot=input-control])이 있으면 그 표면을 잰다.
    const fields = [...row.children]
      .filter((child) => child.tagName === "LABEL")
      .map((label) => {
        const inner = label.querySelector("input, select, textarea");
        const control = label.querySelector('[data-slot="input-control"]') ?? inner;
        return {
          labelText: (label.querySelector("span")?.textContent ?? "").trim(),
          controlLabel: inner?.getAttribute("aria-label") ?? null,
          label: toRect(label),
          control: control ? toRect(control) : null,
        };
      });
    const scroller = (name: string, element: Element | null) => ({
      name,
      scrollWidth: element ? element.scrollWidth : 0,
      clientWidth: element ? element.clientWidth : 0,
      overflowX: element ? getComputedStyle(element).overflowX : "visible",
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

type FocusNeighbor = { labelText: string; cell: Rect; control: Rect | null; hits: boolean; separationPx: number };
type FocusMeasurement = {
  fieldLabel: string;
  boxShadow: string;
  surfaceSlot: string | null;
  cell: Rect;
  control: Rect;
  ring: Rect;
  ringThicknessPx: number;
  ringBeyondCellPx: number;
  ringHitsNeighbor: boolean;
  neighbors: FocusNeighbor[];
};

/** 초점이 간 입력의 표면 box-shadow(프로젝트 초점 고리)가 자기 칸과 이웃 칸에 대해 어디까지 가는지 잰다. */
async function measureFocus(page: Page): Promise<FocusMeasurement> {
  return await page.evaluate(() => {
    type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
    const toRect = (element: Element): Box => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const intersection = (first: Box, second: Box) =>
      Math.min(first.right, second.right) - Math.max(first.x, second.x) > 0.5
      && Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y) > 0.5;

    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) throw new Error("초점이 간 요소가 없습니다");
    const cellElement = active.closest("label");
    if (!cellElement) throw new Error("초점이 간 입력의 칸(label)을 찾지 못했습니다");
    const surface = cellElement.querySelector('[data-slot="input-control"]');
    const ringed = surface ?? active;
    const boxShadow = getComputedStyle(ringed).boxShadow;

    // box-shadow는 색의 rgb(...) 안에도 쉼표가 있으므로 괄호 밖 쉼표에서만 층을 나눈다.
    const layers: string[] = [];
    let depth = 0;
    let current = "";
    for (const character of boxShadow) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        layers.push(current.trim());
        current = "";
      } else current += character;
    }
    if (current.trim()) layers.push(current.trim());

    const control = toRect(ringed);
    let ring: Box = { ...control };
    for (const layer of layers) {
      if (!layer || layer.includes("inset")) continue;
      const numbers = (layer.match(/-?\d*\.?\d+px/g) ?? []).map((value) => Number.parseFloat(value));
      if (numbers.length < 2) continue;
      const offsetX = numbers[0];
      const offsetY = numbers[1];
      const blur = numbers[2] ?? 0;
      const spread = numbers[3] ?? 0;
      const reach = spread + blur / 2;
      ring = {
        x: Math.min(ring.x, control.x + offsetX - reach),
        y: Math.min(ring.y, control.y + offsetY - reach),
        right: Math.max(ring.right, control.right + offsetX + reach),
        bottom: Math.max(ring.bottom, control.bottom + offsetY + reach),
        width: 0,
        height: 0,
      };
    }
    ring.width = ring.right - ring.x;
    ring.height = ring.bottom - ring.y;

    const row = cellElement.parentElement;
    const neighbors: FocusNeighbor[] = row ? [...row.children]
      .filter((child) => child !== cellElement && child.tagName === "LABEL")
      .map((label) => {
        const inner = label.querySelector("input, select, textarea");
        const cell = toRect(label);
        const neighborControl = inner ? toRect(inner) : null;
        return {
          labelText: (label.querySelector("span")?.textContent ?? "").trim(),
          cell,
          control: neighborControl,
          hits: intersection(ring, cell) || (neighborControl ? intersection(ring, neighborControl) : false),
          separationPx: Math.max(cell.x - ring.right, ring.x - cell.right, cell.y - ring.bottom, ring.y - cell.bottom),
        };
      }) : [];

    const cell = toRect(cellElement);
    return {
      fieldLabel: (cellElement.querySelector("span")?.textContent ?? "").trim(),
      boxShadow,
      surfaceSlot: surface ? surface.getAttribute("data-slot") : null,
      cell,
      control,
      ring,
      ringThicknessPx: Math.max((ring.width - control.width) / 2, (ring.height - control.height) / 2),
      ringBeyondCellPx: Math.max(0, cell.x - ring.x, ring.right - cell.right, cell.y - ring.y, ring.bottom - cell.bottom),
      ringHitsNeighbor: neighbors.some((neighbor) => neighbor.hits),
      neighbors,
    };
  });
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
    if ((scroller.name === "document" || scroller.overflowX !== "visible") && scroller.scrollWidth - scroller.clientWidth > 1) {
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
  const settingsButton = page.getByRole("button", { name: "설정", exact: true });
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

async function preparePage(page: Page, width: number) {
  const outDir = process.env.RECURRING_LAYOUT_OUT_DIR
    ? path.resolve(process.env.RECURRING_LAYOUT_OUT_DIR)
    : test.info().outputPath(".");
  mkdirSync(outDir, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("ls.webglGlass", "0"); });
  return {
    outDir,
    capture: async (name: string) => {
      await page.screenshot({ path: path.join(outDir, `${name}.png`), animations: "disabled" });
    },
    write: (name: string, body: unknown) => {
      writeFileSync(path.join(outDir, name), JSON.stringify(body, null, 2));
    },
  };
}

for (const width of WIDTHS) {
  test(`예약 작업 편집기 입력 칸 배치 ${width}`, async ({ page }) => {
    test.setTimeout(240_000);
    const { capture, write } = await preparePage(page, width);
    await installRoutes(page);
    const { tab } = await openRecurringTab(page);

    const violations: string[] = [];
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
          write(`measure-${width}-${angle}-${nameId}-${mode}.json`, { tag, ...measurement });
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

for (const width of ONCE_WIDTHS) {
  test(`예약 작업 편집기 1회 실행 모드 배치 ${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    const { capture, write } = await preparePage(page, width);
    await installRoutes(page);
    const { tab } = await openRecurringTab(page);

    const violations: string[] = [];
    const check = async (angle: "new" | "edit", tag: string) => {
      await settle(page);
      const measurement = await measure(page, width, angle, "once", "once");
      write(`once-${width}-${angle}.json`, { tag, ...measurement });
      await capture(`once-${width}-${angle}`);
      const found = violationsOf(measurement);
      if (found.length > 0) violations.push(`${tag}: ${found.join("; ")}`);
    };

    // 새 작업을 1회 모드로: 시간대 칸이 빠진 배치
    await tab.getByRole("button", { name: "새 작업", exact: true }).click();
    await tab.getByLabel("작업 이름").fill(ONCE_LONG_NAME);
    await tab.getByLabel("반복 주기").selectOption("once");
    await expect(tab.getByLabel("시간대")).toHaveCount(0);
    await expect(tab.getByLabel("실행 일시")).toBeVisible();
    await check("new", `폭 ${width} / 새 작업 / 1회`);

    // 기존 1회 작업 편집: 시간대 칸이 없고 실행 일시 칸이 있다
    await tab.getByRole("button").filter({ hasText: ONCE_LONG_NAME }).first().click();
    await expect(tab.getByLabel("작업 이름")).toHaveValue(ONCE_LONG_NAME);
    await expect(tab.getByLabel("시간대")).toHaveCount(0);
    await expect(tab.getByLabel("실행 일시")).toBeVisible();
    await check("edit", `폭 ${width} / 기존 1회 작업 편집`);

    expect(violations, `1회 실행 모드 배치 위반\n${violations.join("\n")}`).toEqual([]);
  });
}

for (const width of FOCUS_WIDTHS) {
  test(`예약 작업 편집기 초점 고리 측정 ${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    const { capture, write } = await preparePage(page, width);
    await installRoutes(page);
    const { tab } = await openRecurringTab(page);

    await tab.getByRole("button", { name: "새 작업", exact: true }).click();
    await tab.getByLabel("작업 이름").fill(NAMES.korean);
    await tab.getByLabel("반복 주기").selectOption("weekdays");
    await expect(tab.getByLabel("시간대")).toBeVisible();

    // 표면의 box-shadow는 transition-shadow로 서서히 그려진다. 다 그려진 뒤에 잰다.
    const settledFocus = async () => {
      await expect.poll(async () => (await measureFocus(page)).ringThicknessPx, {
        message: "프로젝트 초점 고리가 그려질 때까지 기다림",
        timeout: 2_000,
      }).toBeGreaterThanOrEqual(2);
      return await measureFocus(page);
    };

    await tab.getByLabel("시간대").click();
    await settle(page);
    const timezone = await settledFocus();
    write(`focus-${width}-timezone.json`, { tag: `폭 ${width} / 시간대 칸 초점`, ...timezone });
    await capture(`focus-${width}-timezone`);

    await tab.getByLabel("작업 이름").click();
    await page.keyboard.press("Home");
    await settle(page);
    const name = await settledFocus();
    write(`focus-${width}-name.json`, { tag: `폭 ${width} / 작업 이름 칸 초점`, ...name });
    await capture(`focus-${width}-name`);

    for (const [id, focus] of [["시간대", timezone], ["작업 이름", name]] as const) {
      expect(focus.ringThicknessPx, `${id}: 프로젝트 초점 고리가 그려지지 않음 (box-shadow: ${focus.boxShadow})`).toBeGreaterThanOrEqual(2);
      expect(focus.ringHitsNeighbor, `${id}: 초점 고리가 이웃 칸에 닿음 (${JSON.stringify(focus.neighbors)})`).toBe(false);
      expect(focus.ringBeyondCellPx, `${id}: 초점 고리가 자기 칸에서 ${round(focus.ringBeyondCellPx)}px 넘음`).toBeLessThanOrEqual(4);
    }
  });
}

/**
 * ui-design 0절의 조작 항목(14~18) 가운데 이 화면에 해당하는 것을 같은 실행에서 잰다.
 * 판정은 JSON과 콘솔 출력으로 남기고, 배치 합격 기준(위 테스트)만 실패로 만든다.
 * 16번(최소 폭 넘침)은 위 폭별 테스트가 360px까지 직접 잰다.
 */
test("예약 작업 편집기 조작 항목", async ({ page }) => {
  test.setTimeout(180_000);
  const { capture, write } = await preparePage(page, 1440);
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

  const nodeTrigger = tab.getByLabel("노드 선택", { exact: true });
  await nodeTrigger.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(nodeTrigger).toBeFocused();
  const nodeFocusRestored = await nodeTrigger.evaluate(element => document.activeElement === element);

  // 17. 오류 상태: 실패하면 그 자리에 안내가 서고, 새로고침으로 다시 시도할 수 있다.
  routeState.failJobs = true;
  await tab.getByTestId("recurring-jobs-refresh").click();
  const errorAlert = tab.getByRole("alert");
  await expect(errorAlert).toBeVisible();
  await expect(tab.getByText("없음", { exact: true })).toHaveCount(0);
  await expect(tab.getByText("활성", { exact: true })).toHaveCount(0);
  const errorText = (await errorAlert.textContent())?.trim() ?? "";
  await capture("interaction-error");
  routeState.failJobs = false;
  await tab.getByTestId("recurring-jobs-refresh").click();
  await expect(tab.getByRole("button").filter({ hasText: NAMES.korean }).first()).toBeVisible();
  const alertStillVisible = await errorAlert.isVisible().catch(() => false);
  await expect(errorAlert).toHaveCount(0);

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
    nodeFocusRestored,
  };
  write("interaction.json", report);
  console.log(`조작 항목 측정: ${JSON.stringify(report)}`);

  expect(errorText).toContain("예약 작업을 불러오지 못했습니다");
  expect(resize.every((entry) => entry.violations.length === 0)).toBe(true);
  expect(resize.every((entry) => entry.nameValue === NAMES.korean)).toBe(true);
  expect(resize.every((entry) => entry.dialogFits)).toBe(true);
  expect(tabStops.every((entry) => entry.info.inDialog && entry.info.visible)).toBe(true);
  expect(focusRestored).toBe(true);
});

for (const width of [1440, 360]) {
  for (const create of [false, true]) {
    for (const fail of [false, true]) {
      test(`키보드 ${create ? "생성" : "저장"} ${fail ? "실패" : "성공"} 초점 ${width}`, async ({ page }) => {
        await preparePage(page, width);
        let release!: () => void;
        const state = await installRoutes(page, { failJobs: false, failSave: fail, saveGate: new Promise<void>((resolve) => { release = resolve; }) });
        const { tab } = await openRecurringTab(page);
        await expect(tab.getByText("활성", { exact: true })).toBeVisible();
        await settle(page);
        if (!create) await tab.getByRole("button").filter({ hasText: KOREAN_LONG_NAME }).first().click();
        else {
          await tab.getByLabel("작업 이름").fill("키보드로 만든 작업");
          await tab.getByLabel("작업 내용").fill("보고서를 작성합니다.");
          await tab.getByLabel("노드 선택").click();
          await page.getByRole("option", { name: "eiaserinnys", exact: true }).click();
          await tab.getByLabel("에이전트 선택").click();
          await page.getByRole("option", { name: "로젤린", exact: true }).click();
          await tab.getByRole("combobox").filter({ hasText: "폴더를 선택하세요" }).click();
          await page.getByTestId("new-session-folder-option-folder-amber").click();
        }
        const preview = tab.getByRole("button", { name: "다음 5회 보기", exact: true });
        const action = tab.getByRole("button", { name: create ? "반복 작업 생성" : "변경 저장", exact: true });
        await preview.focus();
        await page.keyboard.press("Tab");
        await expect(action).toBeFocused();
        await page.keyboard.press("Enter");
        const busy = tab.getByRole("button", { name: "저장 중...", exact: true, disabled: true });
        await expect(busy).toHaveAttribute("aria-disabled", "true");
        await expectKeyboardFocus(busy);
        release();
        state.saveGate = undefined;
        if (fail) await expect(tab.getByRole("alert")).toContainText("저장하지 못했습니다");
        const finalAction = tab.getByRole("button", { name: create && fail ? "반복 작업 생성" : "변경 저장", exact: true });
        await expectKeyboardFocus(finalAction);
      });
    }
  }
}

async function expectKeyboardFocus(button: Locator) {
  await expect.poll(() => button.evaluate(element => ({ active: document.activeElement === element, body: document.activeElement === document.body, visible: element.matches(":focus-visible") })))
    .toEqual({ active: true, body: false, visible: true });
}

test("설정 창에서 빠른 Tab과 Shift+Tab 초점 순환", async ({ page }) => {
  test.setTimeout(120_000);
  await preparePage(page, 1440);
  await installRoutes(page);
  const { dialog } = await openRecurringTab(page);
  const escapes: Array<{ direction: string; round: number; step: number; info: Awaited<ReturnType<typeof activeInfo>> }> = [];
  for (const [direction, key] of [["forward", "Tab"], ["backward", "Shift+Tab"]] as const) {
    for (let round = 1; round <= 3; round += 1) {
      await dialog.getByLabel("작업 이름").focus();
      for (let step = 1; step <= 90; step += 1) {
        await page.keyboard.press(key);
        const info = await activeInfo(page);
        if (!info.inDialog) escapes.push({ direction, round, step, info });
      }
    }
  }
  console.log(`초점 이탈: ${JSON.stringify(escapes)}`);
  expect(escapes).toEqual([]);
});

for (const width of [1440, 360]) test(`첫 목록 조회 실패 뒤 새로고침 성공 ${width}`, async ({ page }) => {
  const { capture } = await preparePage(page, width);
  const state = await installRoutes(page, { failJobs: true });
  const { tab } = await openRecurringTab(page);
  await expect(tab.getByRole("alert")).toBeVisible();
  await expect(tab.getByText("없음", { exact: true })).toHaveCount(0);
  await expect(tab.getByText("활성", { exact: true })).toHaveCount(0);
  await capture(`initial-load-error-${width}`);
  state.failJobs = false;
  await tab.getByTestId("recurring-jobs-refresh").click();
  await expect(tab.getByRole("button").filter({ hasText: KOREAN_LONG_NAME }).first()).toBeVisible();
  await expect(tab.getByRole("alert")).toHaveCount(0);
});

for (const width of [1440, 360]) test(`첫 로딩과 저장 실패 안내 ${width}`, async ({ page }) => {
  const { capture } = await preparePage(page, width);
  let release!: () => void;
  const listGate = new Promise<void>((resolve) => { release = resolve; });
  await installRoutes(page, { failJobs: false, failSave: true, listGate });
  const { tab } = await openRecurringTab(page);
  await expect(tab.getByRole("status")).toHaveText("불러오는 중…");
  await expect(tab.getByText("활성", { exact: true })).toHaveCount(0);
  await expect(tab.getByText("없음", { exact: true })).toHaveCount(0);
  await capture(`first-loading-${width}`);
  release();
  await expect(tab.getByText("활성", { exact: true })).toBeVisible();
  const create = tab.getByRole("button", { name: "반복 작업 생성", exact: true });
  await create.evaluate(element => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller) throw new Error("스크롤 칸을 찾지 못했습니다");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await create.click();
  const alert = tab.getByRole("alert");
  await expect(alert).toContainText("저장하지 못했습니다");
  await expect.poll(() => alertInset(alert)).toBeCloseTo(24, 0);
  await capture(`create-error-${width}`);
  await tab.getByRole("button").filter({ hasText: KOREAN_LONG_NAME }).first().click();
  const save = tab.getByRole("button", { name: "변경 저장" });
  await save.evaluate(element => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller) throw new Error("스크롤 칸을 찾지 못했습니다");
    scroller.scrollTop += element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 4;
  });
  await save.click();
  await expect(alert).toContainText("저장하지 못했습니다");
  const position = await alert.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const row = element.previousElementSibling!.getBoundingClientRect();
    return { top: rect.top, rowBottom: row.bottom };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.rowBottom);
  await expect.poll(() => alertInset(alert)).toBeCloseTo(24, 0);
  await capture(`save-error-${width}`);
});

async function alertInset(alert: Locator) {
  return alert.evaluate(element => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller) throw new Error("스크롤 칸을 찾지 못했습니다");
    return scroller.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
  });
}

async function textWrapMetrics(paragraph: Locator) {
  return paragraph.evaluate(element => {
    const node = element.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("설명 텍스트를 찾지 못했습니다");
    const text = node.textContent ?? "";
    const breaks: Array<{ before: string; after: string; boundary: boolean }> = [];
    let previous: { index: number; top: number } | undefined;
    for (let index = 0; index < text.length; index++) {
      if (/\s/.test(text[index])) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const top = range.getBoundingClientRect().top;
      if (previous && Math.abs(top - previous.top) > 1) {
        breaks.push({ before: text[previous.index], after: text[index], boundary: /\s/.test(text.slice(previous.index + 1, index)) });
      }
      previous = { index, top };
    }
    return { wordBreak: getComputedStyle(element).wordBreak, overflowWrap: getComputedStyle(element).overflowWrap, breaks };
  });
}

for (const width of [1440, 390, 360]) {
  test(`설정 목록과 상세 끝선 ${width}`, async ({ page }) => {
    const { capture, write } = await preparePage(page, width);
    await installRoutes(page);
    const { dialog } = await openRecurringTab(page);
    const dialogDescription = await textWrapMetrics(dialog.locator('[data-slot="dialog-description"]'));
    expect.soft(dialogDescription.wordBreak, "설정 창 설명 word-break").toBe("keep-all");
    expect.soft(dialogDescription.overflowWrap, "설정 창 설명 overflow-wrap").toBe("break-word");
    expect.soft(dialogDescription.breaks.filter(line => !line.boundary), "설정 창 설명 낱말 중간 줄바꿈").toEqual([]);
    const measurements: Record<string, unknown> = {};
    measurements.dialogDescription = dialogDescription;
    for (const [label, id] of [["반복 작업", "recurring-jobs-tab"], ["영구 에이전트 세션", "persistent-sessions-tab"]] as const) {
      if (id === "persistent-sessions-tab") {
        if (width <= 640) await dialog.getByRole("button", { name: "모든 설정" }).click();
        await dialog.getByRole("button", { name: label, exact: true }).click();
      }
      const tab = page.getByTestId(id);
      const list = tab.locator("aside");
      const description = list.locator(":scope > div:first-child p");
      if (width === 1440 && id === "recurring-jobs-tab") {
        // 판정기가 낱말 중간 줄바꿈을 실제로 잡는지 확인한 뒤 원래 스타일로 되돌린다.
        await description.evaluate(element => { (element as HTMLElement).style.cssText = "word-break:break-all;width:30px"; });
        const broken = await textWrapMetrics(description);
        expect(broken.breaks.some(line => !line.boundary)).toBe(true);
        await description.evaluate(element => { (element as HTMLElement).style.cssText = ""; });
      }
      const wrap = await textWrapMetrics(description);
      expect.soft(wrap.wordBreak, `${id} word-break`).toBe("keep-all");
      expect.soft(wrap.overflowWrap, `${id} overflow-wrap`).toBe("break-word");
      expect.soft(wrap.breaks.filter(line => !line.boundary), `${id} 낱말 중간 줄바꿈`).toEqual([]);
      const overflow = await list.evaluate(element => ({ list: element.scrollWidth - element.clientWidth,
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      expect.soft(overflow.list, `${id} 목록 가로 넘침`).toBeLessThanOrEqual(1);
      expect.soft(overflow.document, `${id} 문서 가로 넘침`).toBeLessThanOrEqual(1);
      const group = tab.getByText("실행 대상", { exact: true }).locator("..");
      await expect(group).toBeVisible();
      await group.scrollIntoViewIfNeeded();
      await settle(page);
      const edges = await tab.evaluate(element => {
        const list = element.querySelector("aside")!.getBoundingClientRect();
        const detail = element.querySelector(":scope > div")!;
        const group = [...detail.querySelectorAll("div.rounded.border")].find(box => box.querySelector("p")?.textContent === "실행 대상")!.getBoundingClientRect();
        const frame = element.getBoundingClientRect();
        return { listRight: list.right, groupRight: group.right, frameRight: frame.right,
          detailClientRight: detail.getBoundingClientRect().left + detail.clientWidth,
          detailScrollHeight: detail.scrollHeight, detailClientHeight: detail.clientHeight };
      });
      measurements[id] = { ...edges, wrap, overflow };
      await capture(`edges-${id}-${width}`);
      if (width < 1024) expect.soft(Math.abs(edges.listRight - edges.groupRight), `${id} 목록과 상세`).toBeLessThanOrEqual(1);
      else expect.soft(Math.abs(edges.frameRight - edges.groupRight), `${id} 상세와 내용 끝선`).toBeLessThanOrEqual(1);
      expect.soft(edges.groupRight).toBeLessThanOrEqual(edges.detailClientRight + 1);
      if (width === 1440) {
        // 프레임 높이가 제한된 경우에도 상세 스크롤바가 상자의 끝선을 덮지 않는지 확인한다.
        await tab.evaluate(element => { element.style.height = "30rem"; });
        const scrolled = await tab.evaluate(element => {
          const detail = element.querySelector<HTMLElement>(":scope > div")!;
          detail.scrollTop = detail.scrollHeight;
          const group = [...detail.querySelectorAll("div.rounded.border")].find(box => box.querySelector("p")?.textContent === "실행 대상")!.getBoundingClientRect();
          return { scrollTop: detail.scrollTop, scrollHeight: detail.scrollHeight, clientHeight: detail.clientHeight,
            groupRight: group.right, clientRight: detail.getBoundingClientRect().left + detail.clientWidth };
        });
        measurements[`${id}-scrolled`] = scrolled;
        expect.soft(scrolled.scrollTop).toBeGreaterThan(0);
        expect.soft(scrolled.groupRight).toBeLessThanOrEqual(scrolled.clientRight + 1);
        await capture(`edges-${id}-${width}-scrolled`);
      }
    }
    write(`edges-${width}.json`, measurements);
  });
}
