import type { Browser, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";
type FixtureState = "empty" | "short" | "long";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CK_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-ck-checklist-layout"),
);
const strict = process.env.PR_CK_QA_STRICT === "1";

const result = await runPlaywrightLifecycle({
  lockName: `pr-ck-checklist-layout-${strict ? "after" : "before"}`,
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) themes.push(await verifyTheme(browser, theme));
  return { themes };
});

console.log(JSON.stringify({ ok: true, strict, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const states = [];
  for (const state of ["empty", "short", "long"] as const) {
    states.push(await verifyState(browser, theme, state));
  }
  if (strict) {
    const [empty, short, long] = states;
    assert(empty.cardHeight < short.cardHeight, `${theme}: 빈 목록이 짧은 목록보다 작지 않습니다.`);
    assert(short.cardHeight < short.maxHeight, `${theme}: 짧은 목록이 높이 상한까지 늘어났습니다.`);
    assert(long.cardHeight <= long.maxHeight + 1, `${theme}: 긴 목록이 높이 상한을 넘었습니다.`);
    assert(long.scrollHeight > long.scrollClientHeight, `${theme}: 긴 목록의 내부 스크롤이 생기지 않았습니다.`);
  }
  writeMetrics(theme, states);
  return { theme, states };
}

async function verifyState(browser: Browser, theme: Theme, state: FixtureState) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page, theme, state);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();

    const checklist = page.getByTestId("v3-task-checklist");
    const wrapper = checklist.locator(".v3-task-checklist");
    const card = wrapper.getByTestId("task-card");
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.getByTestId("task-card-progress").waitFor({ state: "visible" });
    if (state !== "empty") {
      await card.getByTestId("task-item-row").first().waitFor({ state: "visible" });
      await card.getByTestId("task-item-row").first().hover();
    }

    const metrics = await page.evaluate(() => {
      const checklistWrapper = document.querySelector<HTMLElement>(
        '[data-testid="v3-task-checklist"] .v3-task-checklist',
      );
      const taskCard = checklistWrapper?.querySelector<HTMLElement>('[data-testid="task-card"]');
      const scroll = taskCard?.querySelector<HTMLElement>('[data-testid="task-card-scroll"]');
      const detailScroll = document.querySelector<HTMLElement>(".v3-detail-scroll");
      if (!checklistWrapper || !taskCard || !scroll || !detailScroll) return null;
      return {
        wrapperHeight: checklistWrapper.getBoundingClientRect().height,
        cardHeight: taskCard.getBoundingClientRect().height,
        maxHeight: Number.parseFloat(getComputedStyle(checklistWrapper).maxHeight),
        scrollClientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        detailBottomPadding: Number.parseFloat(getComputedStyle(detailScroll).paddingBottom),
        itemRows: taskCard.querySelectorAll('[data-testid="task-item-row"]').length,
        rowMenus: taskCard.querySelectorAll(
          '[data-testid="task-item-row"] [data-testid="task-row-menu"]',
        ).length,
        actionGroups: taskCard.querySelectorAll('[data-testid="task-item-actions"]').length,
        sharedActionButtons: taskCard.querySelectorAll(
          '[data-testid="task-item-row"] [data-task-row-action]',
        ).length,
        detailToggles: taskCard.querySelectorAll('[data-testid="task-item-details-toggle"]').length,
        openDetails: taskCard.querySelectorAll('[data-testid="task-how-to"]').length,
        firstActionGeometry: (() => {
          const firstRow = taskCard.querySelector<HTMLElement>('[data-testid="task-item-row"]');
          const menu = firstRow?.querySelector<HTMLElement>('[data-testid="task-row-menu"]');
          const toggle = firstRow?.querySelector<HTMLElement>('[data-testid="task-item-details-toggle"]');
          if (!menu || !toggle) return null;
          const menuRect = menu.getBoundingClientRect();
          const toggleRect = toggle.getBoundingClientRect();
          const menuStyle = getComputedStyle(menu);
          const toggleStyle = getComputedStyle(toggle);
          return {
            topDelta: Math.abs(menuRect.top - toggleRect.top),
            widthDelta: Math.abs(menuRect.width - toggleRect.width),
            heightDelta: Math.abs(menuRect.height - toggleRect.height),
            menuRadius: menuStyle.borderRadius,
            toggleRadius: toggleStyle.borderRadius,
            menuPadding: menuStyle.padding,
            togglePadding: toggleStyle.padding,
          };
        })(),
      };
    });
    assert(metrics !== null, `${theme}/${state}: 체크리스트 높이 측정 대상을 찾지 못했습니다.`);
    await capture(page, theme, state);

    if (strict) {
      assert(metrics.detailBottomPadding === 28, `${theme}/${state}: 하단 간격이 28px이 아닙니다.`);
      assert(metrics.openDetails === 0, `${theme}/${state}: 항목 상세가 기본으로 열려 있습니다.`);
      assert(!(await card.innerText()).includes("절차"), `${theme}/${state}: 텍스트 절차 버튼이 남았습니다.`);
      if (state === "empty") {
        assert(metrics.itemRows === 0, `${theme}: 빈 픽스처에 항목이 표시됩니다.`);
      } else {
        assert(metrics.rowMenus === metrics.itemRows, `${theme}/${state}: CRUD 메뉴가 모든 항목에 없습니다.`);
        assert(metrics.actionGroups === metrics.itemRows, `${theme}/${state}: 항목 행 액션 그룹이 없습니다.`);
        assert(metrics.sharedActionButtons === metrics.itemRows * 2, `${theme}/${state}: 공용 행 액션 버튼 정본을 우회했습니다.`);
        assert(metrics.detailToggles === metrics.itemRows, `${theme}/${state}: 상세 아이콘이 모든 항목에 없습니다.`);
        assert(metrics.firstActionGeometry !== null, `${theme}/${state}: 첫 행 액션 기하를 측정하지 못했습니다.`);
        assert(metrics.firstActionGeometry.topDelta <= 1, `${theme}/${state}: 메뉴와 꺽쇠가 같은 줄이 아닙니다.`);
        assert(metrics.firstActionGeometry.widthDelta <= 1, `${theme}/${state}: 메뉴와 꺽쇠 너비가 다릅니다.`);
        assert(metrics.firstActionGeometry.heightDelta <= 1, `${theme}/${state}: 메뉴와 꺽쇠 높이가 다릅니다.`);
        assert(metrics.firstActionGeometry.menuRadius === metrics.firstActionGeometry.toggleRadius, `${theme}/${state}: 메뉴와 꺽쇠 radius가 다릅니다.`);
        assert(metrics.firstActionGeometry.menuPadding === metrics.firstActionGeometry.togglePadding, `${theme}/${state}: 메뉴와 꺽쇠 padding이 다릅니다.`);
      }
      if (state === "short") await verifyShortDisclosure(card);
    }

    assert(browserErrors.length === 0, `${theme}/${state}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return { theme, state, ...metrics, browserErrors: browserErrors.length };
  } finally {
    await context.close();
  }
}

async function verifyShortDisclosure(card: ReturnType<Page["getByTestId"]>) {
  const row = card.getByTestId("task-item-row").filter({ hasText: "요구사항 확인" });
  const toggle = row.getByTestId("task-item-details-toggle");
  assert(await row.getByText("검증자", { exact: true }).count() === 0, "접힌 항목에 담당자가 노출됩니다.");
  assert(await toggle.getAttribute("aria-expanded") === "false", "상세 아이콘의 초기 상태가 닫힘이 아닙니다.");
  assert(await toggle.locator(".lucide-chevron-down").count() === 1, "닫힌 상세에 아래 꺽쇠가 없습니다.");
  assert(await row.evaluate((element) => {
    const actionGroup = element.querySelector('[data-testid="task-item-actions"]');
    const rowMenu = element.querySelector('[data-testid="task-row-menu"]');
    const detailsToggle = element.querySelector('[data-testid="task-item-details-toggle"]');
    return rowMenu?.parentElement === actionGroup
      && detailsToggle?.parentElement === actionGroup
      && rowMenu.nextElementSibling === detailsToggle;
  }), "상세 아이콘이 항목 메뉴 바로 옆에 없습니다.");

  await toggle.click();
  assert(await toggle.getAttribute("aria-expanded") === "true", "상세 아이콘이 펼침 상태로 바뀌지 않았습니다.");
  assert(await toggle.locator(".lucide-chevron-up").count() === 1, "펼친 상세에 위 꺽쇠가 없습니다.");
  assert(await row.getByText("검증자", { exact: true }).isVisible(), "펼친 상세에 담당자가 없습니다.");
  assert(await row.getByText("내 차례", { exact: true }).isVisible(), "펼친 상세에 내 차례 표시가 없습니다.");
  assert(await row.getByText("요청과 완료 조건을 대조한다.", { exact: true }).isVisible(), "펼친 상세에 절차가 없습니다.");
}

async function preparePage(page: Page, theme: Theme, state: FixtureState) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/tasks/rb-alpha", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return fulfillJson(route, snapshotFor(state));
  });
}

function snapshotFor(state: FixtureState) {
  const now = "2026-07-18T00:00:00.000Z";
  const sections = state === "empty" ? [] : [makeSection(now)];
  const count = state === "empty" ? 0 : state === "short" ? 2 : 30;
  const items = Array.from({ length: count }, (_, index) => makeItem(index, now));
  return {
    task: {
      id: "rb-alpha", board_item_id: "task:rb-alpha", folder_id: "folder-amber",
      title: `체크리스트 ${state}`, status: "open", archived: false, version: 1,
      created_session_id: "session-coordinator", created_event_id: 1, created_at: now, updated_at: now,
    },
    sections,
    items,
  };
}

function makeSection(now: string) {
  return {
    id: "section-main", task_id: "rb-alpha", position_key: "000", title: "준비",
    assignee_kind: "human", assignee_agent_id: null, assignee_session_id: null, assignee_user_id: "검증자",
    archived: false, version: 1, created_session_id: "session-coordinator", created_event_id: 1,
    updated_session_id: "session-coordinator", updated_event_id: 1, created_at: now, updated_at: now,
  };
}

function makeItem(index: number, now: string) {
  return {
    id: `item-${index}`, section_id: "section-main", position_key: String(index).padStart(3, "0"),
    title: index === 0 ? "요구사항 확인" : `검증 항목 ${index + 1}`,
    how_to: index === 0 ? "요청과 완료 조건을 대조한다." : `검증 절차 ${index + 1}`,
    status: "pending", assignee_kind: null, assignee_agent_id: null, assignee_session_id: null,
    assignee_user_id: null, archived: false, version: 1, created_session_id: "session-coordinator",
    created_event_id: 1, updated_session_id: "session-coordinator", updated_event_id: 1,
    completed_kind: null, completed_session_id: null, completed_event_id: null, completed_user_id: null,
    completed_at: null, created_at: now, updated_at: now,
  };
}

function writeMetrics(theme: Theme, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: Theme, state: FixtureState) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${state}.png`),
    animations: "disabled",
    fullPage: false,
  });
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
