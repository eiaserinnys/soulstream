import type { Browser, Page, Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CF_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-cf-runbook-crud"),
);
const strict = process.env.PR_CF_QA_STRICT === "1";

const result = await runPlaywrightLifecycle({
  lockName: `pr-cf-runbook-crud-${strict ? "after" : "before"}`,
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push(await verifyTheme(browser, theme));
  }
  return { themes };
});

console.log(JSON.stringify({ ok: true, strict, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
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
  const fixture = createFixture();

  try {
    await preparePage(page, theme, fixture);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();

    const card = page.getByTestId("v3-task-runbook-checklist").getByTestId("runbook-card");
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.getByText("요구사항 확인", { exact: true }).waitFor({ state: "visible" });
    await capture(page, theme, "01-checklist-layout");

    const firstRow = card.getByTestId("runbook-item-row").filter({ hasText: "요구사항 확인" });
    const detailsToggle = firstRow.getByTestId("runbook-item-details-toggle");
    const initialMetrics = await card.evaluate((element) => ({
      itemRows: element.querySelectorAll('[data-testid="runbook-item-row"]').length,
      borderedItemRows: Array.from(element.querySelectorAll<HTMLElement>('[data-testid="runbook-item-row"]'))
        .filter((row) => row.className.includes("border")).length,
      openDetails: element.querySelectorAll('[data-testid="runbook-how-to"]').length,
      rowMenus: element.querySelectorAll('[data-testid="runbook-row-menu"]').length,
    }));

    if (strict) {
      assert(initialMetrics.borderedItemRows === 0, "항목 행에 중첩 보더 프레임이 남았습니다.");
      assert(initialMetrics.openDetails === 0, "항목 상세가 기본으로 닫히지 않았습니다.");
      assert(initialMetrics.rowMenus >= 5, "섹션·항목 CRUD 메뉴가 체크리스트 표면에 없습니다.");
      assert(!await card.getByText("검증자", { exact: true }).isVisible(), "접힌 항목에 담당자가 노출됩니다.");
      await detailsToggle.click();
      assert(
        await firstRow.getByTestId("runbook-how-to").evaluate((element) => element.className.includes("border-l-2")),
        "상세가 왼쪽 규칙선으로 계층화되지 않았습니다.",
      );
      assert(await firstRow.getByText("검증자", { exact: true }).isVisible(), "펼친 상세에 담당자가 없습니다.");
      assert(await firstRow.getByText("내 차례", { exact: true }).isVisible(), "펼친 상세에 내 차례 표시가 없습니다.");
      await detailsToggle.click();
      await exerciseCrud(page, card, fixture, theme);
      await capture(page, theme, "03-crud-complete");
    }

    assert(browserErrors.length === 0, `${theme}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    const metrics = {
      theme,
      strict,
      initialMetrics,
      operations: fixture.operations,
      browserErrors: browserErrors.length,
    };
    writeMetrics(theme, metrics);
    return metrics;
  } finally {
    await context.close();
  }
}

async function exerciseCrud(
  page: Page,
  card: ReturnType<Page["getByTestId"]>,
  fixture: ReturnType<typeof createFixture>,
  theme: Theme,
) {
  await card.getByRole("button", { name: "섹션 추가" }).click();
  const sectionCreate = card.getByTestId("runbook-section-editor");
  await sectionCreate.getByLabel("섹션 제목").fill("배포");
  await capture(page, theme, "02-inline-editor");
  await sectionCreate.getByRole("button", { name: "추가", exact: true }).click();
  await card.getByText("배포", { exact: true }).waitFor({ state: "visible" });

  await openSectionMenu(page, card, "배포");
  await page.getByRole("menuitem", { name: "이름 편집" }).click();
  const sectionUpdate = card.getByTestId("runbook-section-editor");
  await sectionUpdate.getByLabel("섹션 제목").fill("배포 준비");
  await sectionUpdate.getByRole("button", { name: "저장", exact: true }).click();
  await card.getByText("배포 준비", { exact: true }).waitFor({ state: "visible" });

  await openSectionMenu(page, card, "배포 준비");
  await page.getByRole("menuitem", { name: "위로 이동" }).click();
  await expectOrder(card, '[data-testid="runbook-section-toggle"]', ["준비", "배포 준비", "검수"]);

  const planSection = sectionByTitle(card, "준비");
  await planSection.getByRole("button", { name: "항목 추가" }).click();
  const itemCreate = planSection.getByTestId("runbook-item-editor");
  await itemCreate.getByLabel("항목 제목").fill("릴리스 노트 작성");
  await itemCreate.getByLabel("항목 절차").fill("변경점을 한 문단으로 정리한다.");
  await itemCreate.getByRole("button", { name: "추가", exact: true }).click();
  await card.getByText("릴리스 노트 작성", { exact: true }).waitFor({ state: "visible" });

  await openItemMenu(page, card, "릴리스 노트 작성");
  await page.getByRole("menuitem", { name: "항목 편집" }).click();
  const itemUpdate = card.getByTestId("runbook-item-editor");
  await itemUpdate.getByLabel("항목 제목").fill("릴리스 노트 확정");
  await itemUpdate.getByLabel("항목 절차").fill("변경점과 검증 증거를 함께 적는다.");
  await itemUpdate.getByRole("button", { name: "저장", exact: true }).click();
  await card.getByText("릴리스 노트 확정", { exact: true }).waitFor({ state: "visible" });

  await openItemMenu(page, card, "릴리스 노트 확정");
  await page.getByRole("menuitem", { name: "위로 이동" }).click();
  await expectOrder(planSection, '[data-testid="runbook-item-title"]', [
    "요구사항 확인",
    "릴리스 노트 확정",
    "구현 검증",
  ]);

  page.once("dialog", (dialog) => void dialog.accept());
  await openItemMenu(page, card, "릴리스 노트 확정");
  await page.getByRole("menuitem", { name: "항목 아카이브" }).click();
  await card.getByText("릴리스 노트 확정", { exact: true }).waitFor({ state: "detached" });

  page.once("dialog", (dialog) => void dialog.accept());
  await openSectionMenu(page, card, "배포 준비");
  await page.getByRole("menuitem", { name: "섹션 아카이브" }).click();
  await card.getByText("배포 준비", { exact: true }).waitFor({ state: "detached" });

  assert(fixture.operations.join(",") === [
    "create_section",
    "update_section",
    "move_section",
    "create_item",
    "update_item",
    "move_item",
    "archive_item",
    "archive_section",
  ].join(","), `CRUD 호출 순서가 다릅니다: ${fixture.operations.join(",")}`);
}

function sectionByTitle(card: ReturnType<Page["getByTestId"]>, title: string) {
  const exactTitle = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return card.getByTestId("runbook-section-toggle")
    .filter({ hasText: exactTitle })
    .locator("xpath=ancestor::*[@data-testid='runbook-section']");
}

async function openSectionMenu(
  page: Page,
  card: ReturnType<Page["getByTestId"]>,
  title: string,
) {
  const section = sectionByTitle(card, title);
  await section.hover();
  await section.getByRole("button", { name: `${title} 섹션 메뉴` }).click();
  await page.getByRole("menu").waitFor({ state: "visible" });
}

async function openItemMenu(
  page: Page,
  card: ReturnType<Page["getByTestId"]>,
  title: string,
) {
  const row = card.getByTestId("runbook-item-row").filter({ hasText: title });
  await row.hover();
  await row.getByRole("button", { name: `${title} 항목 메뉴` }).click();
  await page.getByRole("menu").waitFor({ state: "visible" });
}

async function expectOrder(
  parent: ReturnType<Page["locator"]>,
  selector: string,
  expected: string[],
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const actual = (await parent.locator(selector).allTextContents()).map((text) => text.trim());
    if (actual.join("|") === expected.join("|")) return;
    await parent.page().waitForTimeout(50);
  }
  const actual = (await parent.locator(selector).allTextContents()).map((text) => text.trim());
  throw new Error(`순서가 다릅니다: ${actual.join("|")} !== ${expected.join("|")}`);
}

function createFixture() {
  const now = "2026-07-17T00:00:00.000Z";
  let sections = [
    makeSection("sec-plan", "000", "준비", now, "human", "검증자"),
    makeSection("sec-review", "001", "검수", now, "agent", null),
  ];
  let items = [
    makeItem("item-brief", "sec-plan", "000", "요구사항 확인", "요청과 완료 조건을 대조한다.", now),
    makeItem("item-build", "sec-plan", "001", "구현 검증", "", now),
    makeItem("item-review", "sec-review", "000", "사용자 확인", "전후 화면을 비교한다.", now),
  ];
  const operations: string[] = [];

  const snapshot = () => ({
    runbook: {
      id: "rb-alpha",
      board_item_id: "runbook:rb-alpha",
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
    sections: structuredClone(sections),
    items: structuredClone(items),
  });

  const install = async (page: Page) => {
    await page.route("**/api/runbooks/rb-alpha", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return fulfillJson(route, snapshot());
    });
    await page.route("**/api/runbooks/rb-alpha/**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const pathname = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const sectionMatch = pathname.match(/\/sections\/([^/]+)$/);
      const sectionMoveMatch = pathname.match(/\/sections\/([^/]+)\/move$/);
      const sectionArchiveMatch = pathname.match(/\/sections\/([^/]+)\/archive$/);
      const itemCreateMatch = pathname.match(/\/sections\/([^/]+)\/items$/);
      const itemMatch = pathname.match(/\/items\/([^/]+)$/);
      const itemMoveMatch = pathname.match(/\/items\/([^/]+)\/move$/);
      const itemArchiveMatch = pathname.match(/\/items\/([^/]+)\/archive$/);

      if (pathname.endsWith("/sections") && typeof body.sectionId === "string") {
        operations.push("create_section");
        sections.push(makeSection(body.sectionId, nextPosition(sections), String(body.title), now, null, null));
      } else if (sectionMoveMatch) {
        operations.push("move_section");
        sections = moveRows(sections, sectionMoveMatch[1], body.beforeSectionId, body.afterSectionId);
      } else if (sectionArchiveMatch) {
        operations.push("archive_section");
        mutateRow(sections, sectionArchiveMatch[1], body, (row) => { row.archived = true; });
      } else if (sectionMatch) {
        operations.push("update_section");
        mutateRow(sections, sectionMatch[1], body, (row) => { row.title = String(body.title); });
      } else if (itemCreateMatch && typeof body.itemId === "string") {
        operations.push("create_item");
        items.push(makeItem(
          body.itemId,
          itemCreateMatch[1],
          nextPosition(items.filter((item) => item.section_id === itemCreateMatch[1])),
          String(body.title),
          String(body.howTo ?? ""),
          now,
        ));
      } else if (itemMoveMatch) {
        operations.push("move_item");
        const target = items.find((item) => item.id === itemMoveMatch[1]);
        if (!target) return fulfillJson(route, { detail: "missing item" }, 404);
        const siblings = moveRows(
          items.filter((item) => item.section_id === target.section_id),
          target.id,
          body.beforeItemId,
          body.afterItemId,
        );
        items = items.filter((item) => item.section_id !== target.section_id).concat(siblings);
      } else if (itemArchiveMatch) {
        operations.push("archive_item");
        mutateRow(items, itemArchiveMatch[1], body, (row) => { row.archived = true; });
      } else if (itemMatch) {
        operations.push("update_item");
        mutateRow(items, itemMatch[1], body, (row) => {
          row.title = String(body.title);
          row.how_to = String(body.howTo ?? "");
        });
      } else {
        return fulfillJson(route, { detail: `unexpected ${pathname}` }, 404);
      }
      return fulfillJson(route, { ok: true, snapshot: snapshot() });
    });
  };

  return { install, operations };
}

function makeSection(
  id: string,
  positionKey: string,
  title: string,
  now: string,
  assigneeKind: string | null,
  assigneeUserId: string | null,
) {
  return {
    id,
    runbook_id: "rb-alpha",
    position_key: positionKey,
    title,
    assignee_kind: assigneeKind,
    assignee_agent_id: assigneeKind === "agent" ? "roselin" : null,
    assignee_session_id: null,
    assignee_user_id: assigneeUserId,
    archived: false,
    version: 1,
    created_session_id: "session-coordinator",
    created_event_id: 1,
    updated_session_id: "session-coordinator",
    updated_event_id: 1,
    created_at: now,
    updated_at: now,
  };
}

function makeItem(
  id: string,
  sectionId: string,
  positionKey: string,
  title: string,
  howTo: string,
  now: string,
) {
  return {
    id,
    section_id: sectionId,
    position_key: positionKey,
    title,
    how_to: howTo,
    status: "pending",
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
    completed_kind: null,
    completed_session_id: null,
    completed_event_id: null,
    completed_user_id: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}

type Row = ReturnType<typeof makeSection> | ReturnType<typeof makeItem>;

function mutateRow<T extends Row>(
  rows: T[],
  id: string,
  body: Record<string, unknown>,
  update: (row: T) => void,
) {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`fixture row not found: ${id}`);
  assert(body.expectedVersion === row.version, `expectedVersion mismatch for ${id}`);
  update(row);
  row.version += 1;
}

function moveRows<T extends Row>(
  rows: T[],
  id: string,
  beforeId: unknown,
  afterId: unknown,
): T[] {
  const ordered = rows.slice().sort((a, b) => a.position_key.localeCompare(b.position_key));
  const index = ordered.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`fixture move row not found: ${id}`);
  const [target] = ordered.splice(index, 1);
  const beforeIndex = typeof beforeId === "string" ? ordered.findIndex((row) => row.id === beforeId) : -1;
  const afterIndex = typeof afterId === "string" ? ordered.findIndex((row) => row.id === afterId) : -1;
  ordered.splice(beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : ordered.length, 0, target);
  return ordered.map((row, rowIndex) => ({
    ...row,
    position_key: String(rowIndex).padStart(3, "0"),
    version: row.id === id ? row.version + 1 : row.version,
  }));
}

function nextPosition(rows: Row[]) {
  return String(rows.length).padStart(3, "0");
}

async function preparePage(
  page: Page,
  theme: Theme,
  fixture: ReturnType<typeof createFixture>,
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

function writeMetrics(theme: Theme, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: false,
  });
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
