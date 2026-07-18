import type { Browser, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BL_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-checklist"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bl-v3-task-checklist",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const fixture = createTaskFixture();
  await preparePage(page, theme, fixture);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const renderStartedAt = performance.now();
    await page.getByTestId("v3-task-alpha").click();

    const checklist = page.getByTestId("v3-task-checklist");
    const taskCard = checklist.getByTestId("task-card");
    await taskCard.waitFor({ state: "visible", timeout: 20_000 });
    await taskCard.getByTestId("task-item-row").first().waitFor({ state: "visible" });
    const renderMs = Math.round(performance.now() - renderStartedAt);

    assert(await checklist.getByTestId("task-card").count() === 1, "업무 창이 공통 TaskCard를 재사용하지 않았습니다.");
    assert(await taskCard.getByTestId("task-card-progress").innerText() === "8/48", "48항목 진행률이 다릅니다.");
    assert(await taskCard.getByTestId("task-section-toggle").count() === 2, "업무 섹션 수가 다릅니다.");
    assert(await taskCard.getByTestId("task-item-row").count() === 40, "완료 섹션이 기본으로 접히지 않았습니다.");
    assert(!await taskCard.getByText("완료 항목 1", { exact: true }).isVisible(), "완료 항목이 기본 접기 정책을 벗어났습니다.");

    const scrollMetrics = await taskCard.evaluate((element) => {
      const viewport = element.querySelector<HTMLElement>(".overflow-y-auto");
      if (!viewport) return null;
      return {
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        cardHeight: (element as HTMLElement).getBoundingClientRect().height,
      };
    });
    assert(scrollMetrics !== null, "업무 내부 스크롤 영역을 찾지 못했습니다.");
    assert(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, "48항목 업무가 업무 창 전체를 밀어내고 있습니다.");
    assert(scrollMetrics.cardHeight <= 520, `업무 카드 높이가 상한을 넘었습니다: ${scrollMetrics.cardHeight}px`);

    const firstToggle = taskCard.getByTestId("task-status-toggle").first().locator('input[type="checkbox"]');
    assert(!await firstToggle.isChecked(), "검증 항목의 초기 상태가 완료입니다.");
    await firstToggle.click();
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="task-status-toggle"] input[type="checkbox"]');
      return input?.checked === true && input.disabled === false;
    });

    assert(fixture.postBodies.length === 2, `CAS 충돌 뒤 POST 횟수가 ${fixture.postBodies.length}회입니다.`);
    assert(fixture.getCount === 2, `CAS 충돌 뒤 재조회 횟수를 포함한 GET이 ${fixture.getCount}회입니다.`);
    assert(fixture.postBodies[0]?.expectedVersion === 1, "첫 상태 변경이 화면의 version 1을 사용하지 않았습니다.");
    assert(fixture.postBodies[1]?.expectedVersion === 2, "충돌 재시도가 재조회한 version 2를 사용하지 않았습니다.");
    assert(fixture.postBodies[0]?.idempotencyKey !== fixture.postBodies[1]?.idempotencyKey, "재시도 idempotency key가 새로 생성되지 않았습니다.");
    assert(await taskCard.getByTestId("task-card-progress").innerText() === "9/48", "완료 처리 뒤 진행률이 갱신되지 않았습니다.");

    const visibleText = await checklist.innerText();
    assert(!visibleText.includes("rb-alpha"), "업무 내부 식별자가 업무 창에 노출되었습니다.");
    assert(!visibleText.includes("active-item"), "항목 내부 식별자가 업무 창에 노출되었습니다.");

    const unexpectedErrors = errors.filter((message) => !message.includes("409 (Conflict)"));
    assert(unexpectedErrors.length === 0, `브라우저 오류가 발생했습니다: ${unexpectedErrors.join(" | ")}`);
    await capture(page, theme, "01-task-checklist");

    return {
      itemCount: 48,
      initiallyRenderedItems: 40,
      completedSectionFolded: true,
      renderMs,
      scrollViewportHeight: scrollMetrics.clientHeight,
      scrollContentHeight: scrollMetrics.scrollHeight,
      casConflictReloadedAndRetried: true,
      progressAfterCompletion: "9/48",
      browserErrors: unexpectedErrors.length,
    };
  } finally {
    await context.close();
  }
}

interface StatusBody {
  status?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

function createTaskFixture() {
  const now = "2026-07-17T00:00:00.000Z";
  let activeVersion = 1;
  let activeStatus = "pending";
  let getCount = 0;
  const postBodies: StatusBody[] = [];

  const section = (id: string, positionKey: string, title: string) => ({
    id,
    task_id: "rb-alpha",
    position_key: positionKey,
    title,
    assignee_kind: "human",
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: "검증자",
    archived: false,
    version: 1,
    created_session_id: "session-coordinator",
    created_event_id: 1,
    updated_session_id: "session-coordinator",
    updated_event_id: 1,
    created_at: now,
    updated_at: now,
  });

  const item = (index: number, sectionId: string, status: string, title: string) => ({
    id: `${sectionId}-item-${index}`,
    section_id: sectionId,
    position_key: String(index).padStart(3, "0"),
    title,
    how_to: "",
    status,
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    archived: false,
    version: 1,
    created_session_id: "session-coordinator",
    created_event_id: 1,
    updated_session_id: "session-coordinator",
    updated_event_id: 1,
    completed_kind: status === "completed" ? "user" : null,
    completed_session_id: status === "completed" ? "session-coordinator" : null,
    completed_event_id: status === "completed" ? 2 : null,
    completed_user_id: status === "completed" ? "검증자" : null,
    completed_at: status === "completed" ? now : null,
    created_at: now,
    updated_at: now,
  });

  const snapshot = () => ({
    task: {
      id: "rb-alpha",
      board_item_id: "task:rb-alpha",
      folder_id: "folder-amber",
      title: "클라이언트 2연속 위임",
      status: "open",
      archived: false,
      version: 7,
      created_session_id: "session-coordinator",
      created_event_id: 1,
      created_at: now,
      updated_at: now,
    },
    sections: [
      section("active-section", "a", "진행 항목"),
      section("completed-section", "b", "완료 항목"),
    ],
    items: [
      {
        ...item(1, "active-section", activeStatus, "사용자 완료 전이 검증"),
        id: "active-item-1",
        version: activeVersion,
      },
      ...Array.from({ length: 39 }, (_, index) => item(index + 2, "active-section", "pending", `진행 항목 ${index + 2}`)),
      ...Array.from({ length: 8 }, (_, index) => item(index + 1, "completed-section", "completed", `완료 항목 ${index + 1}`)),
    ],
  });

  const install = async (page: Page) => {
    await page.route("**/api/tasks/rb-alpha/items/active-item-1/status", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as StatusBody;
      postBodies.push(body);
      if (postBodies.length === 1) {
        activeVersion = 2;
        return fulfillJson(route, { detail: "fixture conflict" }, 409);
      }
      activeStatus = body.status ?? activeStatus;
      activeVersion = 3;
      return fulfillJson(route, { ok: true, snapshot: snapshot() });
    });
    await page.route("**/api/tasks/rb-alpha", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      getCount += 1;
      return fulfillJson(route, snapshot());
    });
  };

  return {
    install,
    postBodies,
    get getCount() {
      return getCount;
    },
  };
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function preparePage(
  page: Page,
  theme: "dark" | "light",
  fixture: ReturnType<typeof createTaskFixture>,
) {
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
  await fixture.install(page);
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
