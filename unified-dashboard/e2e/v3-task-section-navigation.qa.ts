import type { Browser, Locator, Page, Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BP_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-section-navigation"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bp-v3-task-section-navigation",
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

  await preparePage(page, theme);
  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").click();

    const navigation = page.getByRole("navigation", { name: "업무 섹션" });
    const scroll = page.locator(".v3-detail-scroll");
    await navigation.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-runbook-checklist").getByTestId("runbook-item-row").first().waitFor();

    const order = await page.locator("[data-task-section]").evaluateAll((sections) => (
      sections.map((section) => section.getAttribute("data-task-section"))
    ));
    assert(
      JSON.stringify(order) === JSON.stringify(["information", "checklist", "board", "sessions"]),
      `업무 섹션 순서가 다릅니다: ${order.join(" → ")}`,
    );
    assert(await navigation.getByRole("button").count() === 4, "섹션 앵커가 4개가 아닙니다.");
    assert(await currentSectionLabel(navigation) === "정보 섹션으로 이동", "첫 활성 섹션이 정보가 아닙니다.");
    const focusStyle = await navigation.getByRole("button", { name: "정보 섹션으로 이동" })
      .evaluate((element) => {
        (element as HTMLButtonElement).focus();
        const style = getComputedStyle(element);
        return { borderRadius: style.borderRadius, boxShadow: style.boxShadow, outlineStyle: style.outlineStyle };
      });
    assert(focusStyle.borderRadius === "12px", "앵커 포커스 반경이 시각 계약과 다릅니다.");
    assert(focusStyle.boxShadow !== "none", "앵커 포커스 링이 보이지 않습니다.");
    assert(focusStyle.outlineStyle === "none", "사각 outline 포커스가 남아 있습니다.");

    const stickyY = (await navigation.boundingBox())?.y;
    assert(typeof stickyY === "number", "sticky 내비 위치를 측정하지 못했습니다.");

    const checklistButton = navigation.getByRole("button", { name: "체크리스트 섹션으로 이동" });
    await checklistButton.click();
    await waitForCurrent(navigation, "체크리스트 섹션으로 이동");
    await assertAnchored(scroll, "checklist");
    const runbookCard = page.getByTestId("v3-task-runbook-checklist").getByTestId("runbook-card");
    assert(await runbookCard.getByTestId("runbook-card-progress").innerText() === "8/48", "48항목 진행률이 다릅니다.");
    assert(await runbookCard.getByTestId("runbook-item-row").count() === 40, "완료 섹션 기본 접기 뒤 40항목이 보이지 않습니다.");

    const beforeBoardScroll = await scroll.evaluate((element) => element.scrollTop);
    await navigation.getByRole("button", { name: "보드 섹션으로 이동" }).click();
    await waitForCurrent(navigation, "보드 섹션으로 이동");
    const afterBoardScroll = await scroll.evaluate((element) => element.scrollTop);
    assert(afterBoardScroll > beforeBoardScroll, "보드 앵커 클릭 뒤 상세 패널이 스크롤되지 않았습니다.");
    await assertVisibleAfterClick(scroll, "board");
    await navigation.getByRole("button", { name: "세션 섹션으로 이동" }).click();
    await waitForCurrent(navigation, "세션 섹션으로 이동");
    const finalStickyY = (await navigation.boundingBox())?.y;
    assert(Math.abs((finalStickyY ?? -100) - stickyY) <= 1, "본문 스크롤 중 내비가 sticky 위치를 벗어났습니다.");

    const navigationStyle = await navigation.evaluate((element) => {
      const style = getComputedStyle(element);
      return { position: style.position, top: style.top };
    });
    assert(navigationStyle.position === "sticky" && navigationStyle.top === "16px", "내비 sticky 계약이 다릅니다.");
    await capture(page, theme, "01-desktop-anchor-navigation");

    await page.setViewportSize({ width: 600, height: 900 });
    await navigation.waitFor({ state: "hidden" });
    await capture(page, theme, "02-narrow-navigation-hidden");

    assert(errors.length === 0, `브라우저 오류가 발생했습니다: ${errors.join(" | ")}`);
    return {
      sectionOrder: order,
      sectionCount: 4,
      scrollTracking: true,
      clickScrolling: true,
      roundedFocusRing: true,
      stickyTop: navigationStyle.top,
      checklistItems: 48,
      initiallyRenderedChecklistItems: 40,
      narrowNavigationHidden: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
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
  await page.route("**/api/runbooks/rb-alpha", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await fulfillJson(route, runbookSnapshot());
  });
}

async function assertAnchored(
  scroll: Locator,
  sectionId: string,
) {
  const offset = await scroll.evaluate((element, id) => {
    const section = element.querySelector<HTMLElement>(`[data-task-section="${id}"]`);
    if (!section) return null;
    return section.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, sectionId);
  assert(offset !== null && Math.abs(offset - 12) <= 2, `${sectionId} 클릭 스크롤 위치가 다릅니다: ${offset}px`);
}

async function assertVisibleAfterClick(scroll: Locator, sectionId: string) {
  const metrics = await scroll.evaluate((element, id) => {
    const section = element.querySelector<HTMLElement>(`[data-task-section="${id}"]`);
    if (!section) return null;
    const scrollRect = element.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return {
      top: sectionRect.top - scrollRect.top,
      bottom: sectionRect.bottom - scrollRect.top,
      viewportHeight: element.clientHeight,
    };
  }, sectionId);
  assert(
    metrics !== null
      && metrics.top < metrics.viewportHeight
      && metrics.bottom > 0,
    `${sectionId} 클릭 뒤 대상 섹션이 보이지 않습니다: ${JSON.stringify(metrics)}`,
  );
}

async function waitForCurrent(
  navigation: Locator,
  label: string,
) {
  await navigation.locator(`[aria-current="location"][aria-label="${label}"]`)
    .waitFor({ state: "visible" });
}

async function currentSectionLabel(navigation: Locator) {
  return navigation.locator('[aria-current="location"]').getAttribute("aria-label");
}

function runbookSnapshot() {
  const now = "2026-07-17T00:00:00.000Z";
  const section = (id: string, positionKey: string, title: string) => ({
    id,
    runbook_id: "rb-alpha",
    position_key: positionKey,
    title,
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
    created_at: now,
    updated_at: now,
  });
  const item = (index: number, sectionId: string, status: "pending" | "completed") => ({
    id: `${sectionId}-item-${index}`,
    section_id: sectionId,
    position_key: String(index).padStart(3, "0"),
    title: `${status === "completed" ? "완료" : "진행"} 항목 ${index}`,
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
    completed_kind: status === "completed" ? "agent" : null,
    completed_session_id: status === "completed" ? "session-coordinator" : null,
    completed_event_id: status === "completed" ? 2 : null,
    completed_user_id: null,
    completed_at: status === "completed" ? now : null,
    created_at: now,
    updated_at: now,
  });
  return {
    runbook: {
      id: "rb-alpha",
      board_item_id: "runbook:rb-alpha",
      folder_id: "folder-amber",
      title: "v3 플래너 UX 폴리시",
      status: "open",
      archived: false,
      version: 7,
      created_session_id: "session-coordinator",
      created_event_id: 1,
      created_at: now,
      updated_at: now,
    },
    sections: [
      section("active-section", "a", "진행"),
      section("completed-section", "b", "완료"),
    ],
    items: [
      ...Array.from({ length: 40 }, (_, index) => item(index + 1, "active-section", "pending")),
      ...Array.from({ length: 8 }, (_, index) => item(index + 1, "completed-section", "completed")),
    ],
  };
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
