import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const LONG_CHAT_TEXT = "긴 채팅에서도 문장 리듬과 버블 안쪽 여백이 무너지지 않아야 합니다. ".repeat(8).trim();
const LONG_TASK_TITLE = "긴 한국어 업무 제목이 상태·진행 열과 즐겨찾기 클릭 영역을 침범하지 않는지 검증합니다";
const LONG_SESSION_TITLE = "긴 세션 제목이 고정 상태 열을 밀어내지 않는 정렬선 검증";

const phase = process.env.PR_CL_QA_PHASE === "before" ? "before" : "after";
const strict = phase === "after";
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CL_QA_OUTPUT ?? path.join("e2e", "evidence", "pr-cl-visual-system"),
  phase,
);

const result = await runPlaywrightLifecycle({
  lockName: `pr-cl-visual-system-${phase}`,
  timeoutMs: 180_000,
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push(await verifyTheme(browser, theme));
  }
  return { themes };
});

console.log(JSON.stringify({ ok: true, phase, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 2048, height: 1152 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await preparePage(page, theme);
    await openMain(page);
    await applyLongLabels(page);
    const main = await measureMain(page);
    await capture(page, theme, "01-main");

    await page.getByTestId("v3-task-task-alpha").click();
    const run = page.locator(".v3-detail-pane .v3-run-open").filter({ hasText: "시각 QA 순회" });
    await run.waitFor({ state: "visible", timeout: 20_000 });
    await run.click();
    await page.locator(".v3-chat-pane").waitFor({ state: "visible" });
    if (strict) await page.locator('.v3-chat-pane [data-slot="chat-message-bubble"]').first().waitFor({ state: "visible" });
    const detail = await measureDetail(page);
    await capture(page, theme, "02-detail-chat");

    const edges = [];
    for (const viewport of [
      { name: "1440x900", width: 1440, height: 900 },
      { name: "narrow-1024x800", width: 1024, height: 800 },
      { name: "mobile-390x844", width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
      await applyLongLabels(page);
      const measured = await page.evaluate(() => {
        const isVisible = (element: HTMLElement | null) => Boolean(
          element && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0,
        );
        const card = document.querySelector<HTMLElement>(".v3-task-card");
        const planner = document.querySelector<HTMLElement>(".v3-planner");
        if (!card || !planner) throw new Error("반응형 측정 대상을 찾지 못했습니다.");
        return {
          viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cardOverflow: card.scrollWidth - card.clientWidth,
          plannerOverflow: planner.scrollWidth - planner.clientWidth,
          navigationVisible: isVisible(document.querySelector<HTMLElement>(".v3-navigation")),
          sessionPanelVisible: isVisible(document.querySelector<HTMLElement>(".v3-session-panel")),
          mobileTabsVisible: isVisible(document.querySelector<HTMLElement>(".v3-mobile-tabs")),
        };
      });
      edges.push({ ...viewport, ...measured });
      await capture(page, theme, `03-${viewport.name}`);
    }

    const metrics = { theme, main, detail, edges };
    writeMetrics(theme, metrics);
    if (strict) assertAfter(theme, main, detail, edges);
    assert(browserErrors.length === 0, `${theme}: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return metrics;
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
  await page.addInitScript({ content: `
    Object.defineProperty(globalThis, "__name", { configurable: true, value: (target) => target });
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.removeItem("soul-ui.dashboard.leftSidebarWidth");
    localStorage.removeItem("soulstream-v3-session-panel-width");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, { timelineEventCount: 4, liveEventText: LONG_CHAT_TEXT });
}

async function openMain(page: Page) {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".v3-session-panel .v3-run-row").first().waitFor({ state: "visible" });
}

async function applyLongLabels(page: Page) {
  await page.getByTestId("v3-task-task-beta").locator("h3").evaluate((element, title) => {
    element.textContent = title;
  }, LONG_TASK_TITLE);
  await page.locator(".v3-session-panel .v3-run-open strong").nth(1).evaluate((element, title) => {
    element.textContent = title;
  }, LONG_SESSION_TITLE);
}

async function measureMain(page: Page) {
  return page.evaluate(() => {
    const required = <T extends HTMLElement>(selector: string): T => {
      const element = document.querySelector<T>(selector);
      if (!element) throw new Error(`메인 측정 대상을 찾지 못했습니다: ${selector}`);
      return element;
    };
    const fontMetrics = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    };
    const navigation = required<HTMLElement>(".v3-navigation");
    const planner = required<HTMLElement>(".v3-planner");
    const panel = required<HTMLElement>(".v3-session-panel");
    const content = required<HTMLElement>(".v3-planner-scroll > *");
    const taskList = required<HTMLElement>(".v3-task-list");
    const sessionList = required<HTMLElement>(".v3-session-list");
    const taskCard = required<HTMLElement>(".v3-task-card");
    const star = required<HTMLElement>(".v3-task-star-toggle");
    const runOpen = required<HTMLElement>(".v3-session-panel .v3-run-open");
    const projectRow = required<HTMLElement>(".v3-project-nav-row");
    const pageTitle = required<HTMLElement>(".v3-date-head h1");
    const sectionTitle = required<HTMLElement>(".v3-section-head h2");
    const cardTitle = required<HTMLElement>(".v3-task-card h3");
    const nav = navigation.getBoundingClientRect();
    const center = planner.getBoundingClientRect();
    const right = panel.getBoundingClientRect();
    const taskStyle = getComputedStyle(taskCard);
    const runStyle = getComputedStyle(runOpen);
    return {
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      taskGap: Number.parseFloat(getComputedStyle(taskList).gap),
      sessionGap: Number.parseFloat(getComputedStyle(sessionList).gap),
      leftGap: center.left - nav.right,
      rightGap: right.left - center.right,
      outerLeft: nav.left,
      outerRight: innerWidth - right.right,
      navigationWidth: nav.width,
      plannerWidth: center.width,
      sessionWidth: right.width,
      contentWidth: content.getBoundingClientRect().width,
      taskColumns: taskStyle.gridTemplateColumns,
      taskMinHeight: taskStyle.minHeight,
      starSize: { width: star.getBoundingClientRect().width, height: star.getBoundingClientRect().height },
      runColumns: runStyle.gridTemplateColumns,
      projectColumns: getComputedStyle(projectRow).gridTemplateColumns,
      typography: {
        page: fontMetrics(pageTitle),
        section: fontMetrics(sectionTitle),
        card: fontMetrics(cardTitle),
        side: fontMetrics(required<HTMLElement>(".v3-session-panel .v3-run-open strong")),
        meta: fontMetrics(required<HTMLElement>(".v3-run-trailing time")),
        badge: fontMetrics(required<HTMLElement>(".v3-run-status-badge")),
      },
    };
  });
}

async function measureDetail(page: Page) {
  return page.evaluate(() => {
    const required = <T extends HTMLElement>(selector: string): T => {
      const element = document.querySelector<T>(selector);
      if (!element) throw new Error(`상세 측정 대상을 찾지 못했습니다: ${selector}`);
      return element;
    };
    const workspace = required<HTMLElement>(".v3-workspace");
    const detailLayout = required<HTMLElement>(".v3-task-detail-layout");
    const detailScroll = required<HTMLElement>(".v3-detail-scroll");
    const detailHeader = required<HTMLElement>(".v3-workspace-toolbar");
    const chatHeader = required<HTMLElement>(".v3-chat-header");
    const checklist = required<HTMLElement>(".v3-task-checklist");
    const composer = document.querySelector<HTMLElement>('[data-slot="chat-input-composer"]');
    const bubble = document.querySelector<HTMLElement>('.v3-chat-pane [data-slot="chat-message-bubble"]');
    const row = document.querySelector<HTMLElement>('.v3-chat-pane [data-slot="chat-message-row"]');
    const workspaceColumns = getComputedStyle(workspace).gridTemplateColumns.split(" ");
    const detailStyle = getComputedStyle(detailLayout);
    const detailPadding = getComputedStyle(detailScroll);
    const bubbleStyle = bubble ? getComputedStyle(bubble) : null;
    const rowStyle = row ? getComputedStyle(row) : null;
    return {
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workspaceColumns,
      detailColumns: detailStyle.gridTemplateColumns,
      detailGap: Number.parseFloat(detailStyle.columnGap),
      detailBottomPadding: Number.parseFloat(detailPadding.paddingBottom),
      detailHeaderHeight: detailHeader.getBoundingClientRect().height,
      chatHeaderHeight: chatHeader.getBoundingClientRect().height,
      checklistHeight: checklist.getBoundingClientRect().height,
      checklistMaxHeight: getComputedStyle(checklist).maxHeight,
      composerHeight: composer?.getBoundingClientRect().height ?? null,
      bubble: bubbleStyle ? {
        maxWidth: bubbleStyle.maxWidth,
        paddingTop: bubbleStyle.paddingTop,
        paddingRight: bubbleStyle.paddingRight,
        paddingBottom: bubbleStyle.paddingBottom,
        paddingLeft: bubbleStyle.paddingLeft,
      } : null,
      row: rowStyle ? { paddingTop: rowStyle.paddingTop, paddingBottom: rowStyle.paddingBottom } : null,
    };
  });
}

function assertAfter(theme: Theme, main: Awaited<ReturnType<typeof measureMain>>, detail: Awaited<ReturnType<typeof measureDetail>>, edges: Array<Record<string, unknown>>) {
  assert(main.viewportOverflow <= 0, `${theme}: 메인 viewport overflow ${main.viewportOverflow}px`);
  assert(main.taskGap === 4, `${theme}: 중앙 카드 gap ${main.taskGap}px`);
  assert(main.sessionGap === 4, `${theme}: 우측 세션 gap ${main.sessionGap}px`);
  assert(close(main.leftGap, 16) && close(main.rightGap, 16), `${theme}: 3열 gap ${main.leftGap}/${main.rightGap}px`);
  assert(close(main.outerLeft, 20) && close(main.outerRight, 20), `${theme}: 외곽 inset ${main.outerLeft}/${main.outerRight}px`);
  assert(close(main.navigationWidth, 336), `${theme}: 내비 폭 ${main.navigationWidth}px`);
  assert(close(main.sessionWidth, 500), `${theme}: 세션 폭 ${main.sessionWidth}px`);
  assert(main.contentWidth <= 961, `${theme}: 중앙 콘텐츠 폭 ${main.contentWidth}px`);
  assert(main.taskColumns.endsWith("156px 44px"), `${theme}: 업무 카드 열 ${main.taskColumns}`);
  assert(close(main.starSize.width, 44) && close(main.starSize.height, 44), `${theme}: 즐겨찾기 클릭 영역 ${main.starSize.width}/${main.starSize.height}px`);
  assert(main.runColumns.startsWith("28px ") && main.runColumns.endsWith(" 64px"), `${theme}: 세션 행 열 ${main.runColumns}`);
  assert(main.projectColumns.startsWith("16px 12px 18px "), `${theme}: 프로젝트 행 열 ${main.projectColumns}`);
  assert(main.typography.page.size === "21px" && main.typography.page.line === "28px" && main.typography.page.weight === "680", `${theme}: page 타이포 불일치`);
  assert(main.typography.section.size === "16px" && main.typography.section.line === "24px" && main.typography.section.weight === "650", `${theme}: section 타이포 불일치`);
  assert(main.typography.card.size === "16px" && main.typography.card.line === "23px" && main.typography.card.weight === "600", `${theme}: card 타이포 불일치`);
  assert(main.typography.side.size === "14px" && main.typography.side.line === "20px" && main.typography.side.weight === "600", `${theme}: side 타이포 불일치`);
  assert(main.typography.meta.size === "12px" && main.typography.meta.line === "18px" && main.typography.meta.weight === "500", `${theme}: meta 타이포 불일치`);
  assert(main.typography.badge.size === "11px" && main.typography.badge.line === "16px" && main.typography.badge.weight === "600", `${theme}: badge 타이포 불일치`);
  assert(detail.workspaceColumns[1] === "16px", `${theme}: 상세/채팅 gap ${detail.workspaceColumns.join(" ")}`);
  assert(detail.detailColumns.startsWith("72px ") && close(detail.detailGap, 24), `${theme}: 상세 내비 열 ${detail.detailColumns}/${detail.detailGap}`);
  assert(close(detail.detailBottomPadding, 28), `${theme}: 상세 하단 ${detail.detailBottomPadding}px`);
  assert(close(detail.detailHeaderHeight, 56) && close(detail.chatHeaderHeight, 56), `${theme}: 헤더 높이 ${detail.detailHeaderHeight}/${detail.chatHeaderHeight}px`);
  assert(detail.checklistHeight > 0, `${theme}: 체크리스트 높이가 0입니다.`);
  if (detail.composerHeight !== null) assert(detail.composerHeight >= 56, `${theme}: 입력창 높이 ${detail.composerHeight}px`);
  assert(detail.bubble !== null, `${theme}: 긴 채팅 버블을 찾지 못했습니다.`);
  assert(detail.row !== null, `${theme}: 긴 채팅 행을 찾지 못했습니다.`);
  assert(detail.bubble.paddingTop === "14px" && detail.bubble.paddingRight === "16px", `${theme}: 버블 padding 불일치`);
  assert(detail.row.paddingTop === "6px" && detail.row.paddingBottom === "6px", `${theme}: 메시지 gap 불일치`);
  for (const edge of edges) {
    assert(Number(edge.viewportOverflow) <= 0 && Number(edge.cardOverflow) <= 0 && Number(edge.plannerOverflow) <= 0, `${theme}/${edge.name}: overflow ${JSON.stringify(edge)}`);
  }
  const narrow = edges.find((edge) => edge.name === "narrow-1024x800");
  const mobile = edges.find((edge) => edge.name === "mobile-390x844");
  assert(narrow?.sessionPanelVisible === false, `${theme}: 좁은 데스크톱에서 우측 패널이 남았습니다.`);
  assert(mobile?.navigationVisible === false && mobile?.mobileTabsVisible === true, `${theme}: 모바일 단일 패널 전환이 깨졌습니다.`);
}

function writeMetrics(theme: Theme, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: false });
}

function close(actual: number, expected: number) {
  return Math.abs(actual - expected) <= 1;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
