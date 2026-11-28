import { koreanLocale } from "./korean-locale.mjs";
import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BF_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-panel-layout"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-bf-v3-panel-layout",
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
    viewport: { width: 1600, height: 1000 },
    locale: koreanLocale,
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const sessionRequests: string[] = [];
  let folderBoardRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sessions") sessionRequests.push(url.search);
    // 보드 항목 조회 쿼리 정본은 folderId다(client/v3/folder-inline-board-api.ts:32).
    if (url.pathname === "/api/board-items" && url.searchParams.has("folderId")) {
      folderBoardRequests += 1;
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[pr-az/${theme}] pageerror`, error);
  });
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("v3-session-panel");
    await panel.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-session-id="run-alpha-2"]').waitFor({ state: "visible" });

    const initialResizeHandle = page.getByTestId("v3-session-panel-resize-handle").locator(":scope > div");
    const initialResizeHandleBox = await initialResizeHandle.boundingBox();
    const legacyInitialPanelBox = await panel.boundingBox();
    assert(initialResizeHandleBox !== null && initialResizeHandleBox.height > 800, `초기 우측 리사이즈 히트박스 높이가 ${initialResizeHandleBox?.height ?? 0}px입니다.`);
    assert(legacyInitialPanelBox !== null && Math.abs(legacyInitialPanelBox.width - 420) <= 1, `저장된 초기 폭이 ${legacyInitialPanelBox?.width ?? 0}px입니다.`);
    await page.mouse.move(
      initialResizeHandleBox.x + initialResizeHandleBox.width / 2,
      initialResizeHandleBox.y + initialResizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      initialResizeHandleBox.x - 80,
      initialResizeHandleBox.y + initialResizeHandleBox.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
    await page.waitForFunction(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="v3-session-panel"]');
      const stored = Number(localStorage.getItem("soulstream-v3-session-panel-width"));
      return panel !== null && stored > 420
        && Math.abs(panel.getBoundingClientRect().width - stored) <= 1;
    });
    const expandedInitialPanelBox = await panel.boundingBox();
    assert(expandedInitialPanelBox !== null && expandedInitialPanelBox.width >= 490, `초기 420px 상태에서 드래그 뒤 폭이 ${expandedInitialPanelBox?.width ?? 0}px입니다.`);
    await capture(page, theme, "00-initial-legacy-width-resized");

    const scrollbarContract = await page.evaluate(() => {
      const navigation = document.querySelector<HTMLElement>(".v3-navigation-scroll");
      const sessions = document.querySelector<HTMLElement>(".v3-session-panel-scroll");
      if (!navigation || !sessions) throw new Error("좌우 스크롤 표면을 찾지 못했습니다.");
      const left = getComputedStyle(navigation);
      const right = getComputedStyle(sessions);
      return {
        leftWidth: left.scrollbarWidth,
        rightWidth: right.scrollbarWidth,
        leftColor: left.scrollbarColor,
        rightColor: right.scrollbarColor,
      };
    });
    assert(scrollbarContract.leftWidth === "thin", `좌측 스크롤바 폭이 ${scrollbarContract.leftWidth}입니다.`);
    assert(scrollbarContract.rightWidth === scrollbarContract.leftWidth, "좌우 스크롤바 폭 정본이 다릅니다.");
    assert(scrollbarContract.rightColor === scrollbarContract.leftColor, "좌우 스크롤바 색상 정본이 다릅니다.");

    const layoutCombinations = [];
    // 폭 한도 정본은 client/v3/v3-main-columns.ts다(상수 7·9·11·13줄, 예산식 25-29줄,
    // 해석 36-55줄). 1600px에서 예산 = 1600 - 2·22 - 2·16 - 384 = 1140이고
    // (패널 갭 16은 v3-layout-metrics.ts:6), 좌 220/우 240 선호는 220/300,
    // 264/300은 그대로, 900/900은 좌 840·우 300으로 잘린다.
    for (const widths of [
      { navigation: 220, session: 240, expectedNavigation: 220, expectedSession: 300 },
      { navigation: 264, session: 300, expectedNavigation: 264, expectedSession: 300 },
      { navigation: 900, session: 900, expectedNavigation: 840, expectedSession: 300 },
    ]) {
      await page.evaluate(({ navigation, session }) => {
        localStorage.setItem("soul-ui.dashboard.leftSidebarWidth", String(navigation));
        localStorage.setItem("soulstream-v3-session-panel-width", String(session));
      }, widths);
      await page.reload({ waitUntil: "domcontentloaded" });
      await panel.waitFor({ state: "visible", timeout: 20_000 });
      await page.locator('[data-session-id="run-alpha-2"]').waitFor({ state: "visible" });
      const measured = await page.evaluate(() => {
        const navigation = document.querySelector<HTMLElement>(".v3-navigation");
        const planner = document.querySelector<HTMLElement>(".v3-planner");
        const panel = document.querySelector<HTMLElement>('[data-testid="v3-session-panel"]');
        const panelScroll = document.querySelector<HTMLElement>(".v3-session-panel-scroll");
        const plannerContent = document.querySelector<HTMLElement>(".v3-planner-scroll > *");
        const rows = [...document.querySelectorAll<HTMLElement>(".v3-session-row .v3-run-row")];
        if (!navigation || !planner || !panel || !panelScroll || !plannerContent) {
          throw new Error("3열 레이아웃 측정 대상을 찾지 못했습니다.");
        }
        const navigationBox = navigation.getBoundingClientRect();
        const plannerBox = planner.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return {
          viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panelOverflow: panelScroll.scrollWidth - panelScroll.clientWidth,
          rowOverflow: rows.map((row) => row.scrollWidth - row.clientWidth),
          leftGap: plannerBox.left - navigationBox.right,
          rightGap: panelBox.left - plannerBox.right,
          plannerWidth: plannerBox.width,
          contentWidth: plannerContent.getBoundingClientRect().width,
          navigationWidth: navigationBox.width,
          sessionWidth: panelBox.width,
        };
      });
      assert(Math.abs(measured.navigationWidth - widths.expectedNavigation) <= 1, `좌측 내비 상한 실측이 ${measured.navigationWidth}px입니다.`);
      assert(Math.abs(measured.sessionWidth - widths.expectedSession) <= 1, `우측 패널 상한 실측이 ${measured.sessionWidth}px입니다.`);
      assert(measured.viewportOverflow <= 0, `${widths.navigation}/${widths.session}px 조합에서 viewport 가로 넘침 ${measured.viewportOverflow}px`);
      assert(measured.panelOverflow <= 0, `${widths.navigation}/${widths.session}px 조합에서 우측 패널 가로 넘침 ${measured.panelOverflow}px`);
      assert(measured.rowOverflow.every((value) => value <= 0), `${widths.navigation}/${widths.session}px 조합에서 행 가로 넘침 ${measured.rowOverflow.join(",")}px`);
      // 열 사이 gap 정본은 v3-layout-metrics.ts:6의 V3_PANEL_GAP_PX=16이고,
      // v3-planner.css:5-12의 .v3-shell 그리드가 그 값을 두 열 사이에 쓴다.
      // 22px는 바깥 여백(v3-main-columns.ts:13)이라 열 사이 gap과 다르다.
      assert(Math.abs(measured.leftGap - 16) <= 1, `${widths.navigation}/${widths.session}px 조합의 좌측 gap이 ${measured.leftGap}px입니다.`);
      assert(Math.abs(measured.rightGap - 16) <= 1, `${widths.navigation}/${widths.session}px 조합의 우측 gap이 ${measured.rightGap}px입니다.`);
      // 중앙 콘텐츠 상한 정본은 v3-layout-metrics.ts:9의 V3_CONTENT_MAX_WIDTH_PX=960이다.
      // V3DashboardLayout.tsx:615가 --v3-content-max-width로 내려주고
      // v3-visual-system.css:26-28의 .v3-planner-scroll > *가 그 값을 쓴다.
      assert(measured.contentWidth <= 961, `${widths.navigation}/${widths.session}px 조합의 중앙 콘텐츠가 ${measured.contentWidth}px로 과도하게 확장됐습니다.`);
      layoutCombinations.push({ ...widths, ...measured });
    }

    await page.evaluate(() => {
      localStorage.setItem("soul-ui.dashboard.leftSidebarWidth", "264");
      localStorage.setItem("soulstream-v3-session-panel-width", "300");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await panel.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-session-id="run-alpha-2"]').waitFor({ state: "visible" });

    const resizeHandle = page.getByTestId("v3-session-panel-resize-handle").locator(":scope > div");
    const handleBox = await resizeHandle.boundingBox();
    assert(handleBox !== null && handleBox.height > 800, `우측 리사이즈 히트박스 높이가 ${handleBox?.height ?? 0}px입니다.`);
    const initialPanelBox = await panel.boundingBox();
    assert(initialPanelBox !== null, "우측 세션 패널 폭을 측정하지 못했습니다.");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 80, handleBox.y + handleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="v3-session-panel"]');
      const stored = Number(localStorage.getItem("soulstream-v3-session-panel-width"));
      return panel !== null && Number.isFinite(stored)
        && Math.abs(panel.getBoundingClientRect().width - stored) <= 1;
    });
    const resizedPanelBox = await panel.boundingBox();
    assert(resizedPanelBox !== null && resizedPanelBox.width >= initialPanelBox.width + 70, `우측 패널 폭이 드래그 뒤 ${initialPanelBox.width}px → ${resizedPanelBox?.width ?? 0}px로 변했습니다.`);
    const storedWidth = await page.evaluate(() => localStorage.getItem("soulstream-v3-session-panel-width"));
    assert(storedWidth === String(Math.round(resizedPanelBox.width)), `저장 폭 ${storedWidth}와 실측 폭 ${resizedPanelBox.width}px가 다릅니다.`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await panel.waitFor({ state: "visible", timeout: 20_000 });
    const restoredPanelBox = await panel.boundingBox();
    assert(restoredPanelBox !== null && Math.abs(restoredPanelBox.width - resizedPanelBox.width) <= 1, `복원 폭 ${restoredPanelBox?.width ?? 0}px와 저장 폭 ${resizedPanelBox.width}px가 다릅니다.`);

    const richRow = page.getByTestId("v3-session-row-run-alpha-2");
    await richRow.locator(".v3-run-row").waitFor({ state: "visible" });
    for (const text of ["시각 QA 순회", "로젤린", "eiaserinnys", "다크·라이트 실제 픽셀 순회를 진행하고 있습니다.", "실행 중"]) {
      assert((await richRow.textContent())?.includes(text), `RichSessionRow에 ${text} 표시가 없습니다.`);
    }
    assert(await richRow.locator(".v3-run-avatar").count() === 1, "RichSessionRow 아바타가 없습니다.");
    await capture(page, theme, "01-three-column-shell");

    await page.locator('[data-session-id="run-alpha-2"]').click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })
      .waitFor({ state: "visible" });
    await page.locator('.v3-chat-pane[aria-label="세션 채팅"]').waitFor({ state: "visible" });
    assert(await page.getByTestId("v3-standalone-task-empty").count() === 0, "폴더 소속 세션이 단독 모드로 열렸습니다.");
    // 폴더 소속 세션을 열면 그 폴더의 보드 항목을 한 번만 읽는다(쿼리 정본 folderId,
    // 공유 읽기 정본 client/v3/folder-inline-board-api.ts의 loadFolderBoardItems).
    // 플래너 인라인과 워크스페이스가 같은 폴더와 invalidation key로 마운트되어도
    // 진행 중 요청에 합류하므로 폴더 소속 세션을 처음 열 때 요청은 1회다.
    assert(folderBoardRequests === 1, `폴더 소속 세션을 처음 열 때 보드 항목을 ${folderBoardRequests}회 요청했습니다.`);
    await capture(page, theme, "02-task-session-active-chat");
    // run-alpha-2의 폴더(rb-alpha)는 fixture에서 folder-amber의 자식이다. 현행
    // 헤더는 부모가 있으면 「상위 폴더로 이동」을 쓴다(client/v3/FolderDetailPane.tsx:209).
    // 플래너 뒤에도 같은 헤더가 있으므로 워크스페이스 툴바로 범위를 좁힌다.
    await page.locator(".v3-workspace .v3-workspace-toolbar")
      .getByRole("button", { name: "상위 폴더로 이동" }).click();

    await page.locator('[data-session-id="review-session"]').click();
    await page.getByTestId("v3-standalone-task-empty").waitFor({ state: "visible" });
    await page.getByTestId("v3-standalone-session-chat").waitFor({ state: "visible" });
    await capture(page, theme, "03-standalone-session-chat");
    await page.getByRole("button", { name: "폴더 창 닫기" }).click();

    const removed = page.getByTestId("v3-session-row-review-session-2");
    const untouched = page.getByTestId("v3-session-row-review-session-3");
    await removed.waitFor({ state: "visible" });
    await startReviewMutationObserver(page, "review-session-3");
    // 검수 확인은 행만 지워야 한다. 폴더 보드 항목을 다시 읽으면 안 된다.
    const boardRequestsBeforeAcknowledge = folderBoardRequests;
    // 행 전체도 role=button이고 그 접근 이름에 안쪽 라벨이 섞여 두 개가 잡힌다.
    // 확인 처리 아이콘 캡의 aria-label만 정확히 누른다(DashboardIconCap).
    await removed.locator('button[aria-label="추가 검수 세션 2 확인 처리"]').click();
    await removed.waitFor({ state: "detached" });
    const mutations = await stopReviewMutationObserver(page);
    assert(await panel.isVisible(), "검수 확인 뒤 우측 세션 패널이 닫혔습니다.");
    assert(await untouched.isVisible(), "검수 확인이 다른 행을 제거했습니다.");
    assert(mutations.untouched === 0, `검수 확인이 다른 행을 ${mutations.untouched}회 변경했습니다.`);
    assert(mutations.listChild === 1, `검수 확인이 목록 구조를 ${mutations.listChild}회 변경했습니다.`);
    assert(folderBoardRequests === boardRequestsBeforeAcknowledge,
      `검수 확인이 폴더 보드 항목을 ${folderBoardRequests - boardRequestsBeforeAcknowledge}회 더 요청했습니다.`);
    // 우측 패널의 행 조회는 session_id로 좁혀야 한다. 검수 큐 개수 조회
    // (review_state=needs_review&limit=0)는 항목을 싣지 않는 별도 쿼리다
    // (client/v3/use-v3-live-data-plane.ts:32-35).
    assert(sessionRequests.every((query) =>
      query.includes("session_id=") || (query.includes("review_state=needs_review") && query.includes("limit=0"))),
      `우측 패널이 전체 세션 조회를 만들었습니다: ${sessionRequests.join(", ")}`);
    assert(pageErrors.length === 0, `브라우저 오류가 발생했습니다: ${pageErrors.join(" | ")}`);
    await capture(page, theme, "04-review-row-removed");

    return {
      taskSession: true,
      standaloneSession: true,
      reviewRowOnly: mutations,
      folderBoardRequests,
      fullSessionRequests: sessionRequests.filter((query) => !query.includes("session_id=")).length,
      resize: {
        hitboxHeight: handleBox.height,
        before: initialPanelBox.width,
        after: resizedPanelBox.width,
        restored: restoredPanelBox.width,
      },
      initialResize: {
        hitboxHeight: initialResizeHandleBox.height,
        before: legacyInitialPanelBox.width,
        after: expandedInitialPanelBox.width,
      },
      layoutCombinations,
      richRow: true,
      scrollbarContract,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    if (sessionStorage.getItem("pr-ca-initial-width-seeded") !== "1") {
      localStorage.setItem("soulstream-v3-session-panel-width", "420");
      sessionStorage.setItem("pr-ca-initial-width-seeded", "1");
    }
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
}

async function startReviewMutationObserver(page: Page, untouchedSessionId: string) {
  await page.evaluate((sessionId) => {
    const list = document.querySelector('[data-testid="v3-session-group-review"] .v3-session-list');
    const untouched = document.querySelector(`[data-testid="v3-session-row-${sessionId}"]`);
    if (!list || !untouched) throw new Error("검수 MutationObserver 대상을 찾지 못했습니다.");
    const state = { listChild: 0, untouched: 0, observers: [] as MutationObserver[] };
    const listObserver = new MutationObserver((records) => { state.listChild += records.length; });
    listObserver.observe(list, { childList: true });
    const untouchedObserver = new MutationObserver((records) => { state.untouched += records.length; });
    untouchedObserver.observe(untouched, { attributes: true, characterData: true, childList: true, subtree: true });
    state.observers.push(listObserver, untouchedObserver);
    (window as Window & { __prAuReviewObserver?: typeof state }).__prAuReviewObserver = state;
  }, untouchedSessionId);
}

async function stopReviewMutationObserver(page: Page): Promise<{ listChild: number; untouched: number }> {
  return await page.evaluate(() => {
    const state = (window as Window & {
      __prAuReviewObserver?: { listChild: number; untouched: number; observers: MutationObserver[] };
    }).__prAuReviewObserver;
    if (!state) throw new Error("검수 MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return { listChild: state.listChild, untouched: state.untouched };
  });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
