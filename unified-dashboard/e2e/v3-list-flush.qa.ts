import type { Browser, Page } from "@playwright/test";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const baselineMode = process.env.PR_AR_BASELINE === "1";

const result = await runPlaywrightLifecycle({
  lockName: baselineMode ? "pr-ar-v3-list-flush-baseline" : "pr-ar-v3-list-flush-fixed",
  timeoutMs: 150_000,
}, async ({ browser }) => verify(browser));

console.log(JSON.stringify({ ok: true, baselineMode, residualProcesses: 0, ...result }, null, 2));

async function verify(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const requestCounts = new Map<string, number>();
  let projectRequests = 0;
  let runHistoryRequests = 0;
  let transientProjectEmpty = false;
  let includeThirdRun = false;

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
  });
  page.on("pageerror", (error) => console.error(`[pr-ar/qa pageerror] ${error.stack ?? error.message}`));
  await preparePage(page);
  await installV3VisualQaRoutes(page, {
    contextMenuParity: true,
    emptyProjectPlannerWhen: () => {
      if (!transientProjectEmpty) return false;
      transientProjectEmpty = false;
      return true;
    },
    includeAlphaThirdRunWhen: () => includeThirdRun,
    onPlannerProjectRequest: (count) => { projectRequests = count; },
    onRunHistoryRequest: (count) => { runHistoryRequests = count; },
  });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true })
      .click();
    await page.getByRole("heading", { name: fixtureTitles.project }).waitFor({ state: "visible" });
    const taskCard = page.getByTestId("v3-task-task-alpha");
    await taskCard.waitFor({ state: "visible" });
    await taskCard.click({ force: true });
    try {
      await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      console.error(`[pr-ar/qa] 업무 진입 실패\n${(await page.locator("body").innerText()).slice(0, 4_000)}`);
      throw error;
    }
    await waitUntil(async () => (
      await page.locator('.v3-run-list .v3-run-row[data-load-state="ready"]').count()
    ) === 2, "업무 세션 상세 초기 로드");
    await page.waitForTimeout(300);

    const before = snapshotCounts(requestCounts);
    const beforeProjectRequests = projectRequests;
    const beforeRunHistoryRequests = runHistoryRequests;
    transientProjectEmpty = true;
    await startMutationObservers(page);
    const observationStartedAt = Date.now();
    await page.waitForTimeout(5_000);
    await emitSessionUpdated(page, "시각 QA 순회");
    await page.waitForTimeout(100);
    await emitCatalogUpdated(page);
    await page.waitForTimeout(Math.max(0, 30_000 - (Date.now() - observationStartedAt)));
    const mutations = await stopMutationObservers(page);
    transientProjectEmpty = false;
    const after = snapshotCounts(requestCounts);
    const stableWindow = {
      durationMs: Date.now() - observationStartedAt,
      mutations,
      plannerRequestDelta: plannerDelta(before, after),
      projectRequestDelta: projectRequests - beforeProjectRequests,
      runHistoryRequestDelta: runHistoryRequests - beforeRunHistoryRequests,
      sessionRequestDelta: (after["/api/sessions"] ?? 0) - (before["/api/sessions"] ?? 0),
    };
    console.log(`[pr-ar/qa stable] ${JSON.stringify(stableWindow)}`);

    if (baselineMode) return { stableWindow };

    assert(mutations.project === 0, `프로젝트 리스트 DOM 변이 ${mutations.project}건`);
    assert(mutations.runHistory === 0, `업무 세션 리스트 DOM 변이 ${mutations.runHistory}건`);
    assert(stableWindow.plannerRequestDelta === 0, `동등 이벤트가 planner를 ${stableWindow.plannerRequestDelta}회 재조회했습니다.`);
    assert(stableWindow.projectRequestDelta === 0, `프로젝트를 ${stableWindow.projectRequestDelta}회 재조회했습니다.`);
    assert(stableWindow.runHistoryRequestDelta === 0, `run history를 ${stableWindow.runHistoryRequestDelta}회 재조회했습니다.`);

    const transientBefore = projectRequests;
    await startProjectMutationObserver(page);
    transientProjectEmpty = true;
    await emitRunbookUpdated(page);
    await waitUntil(() => projectRequests >= transientBefore + 2, "빈 프로젝트 응답 재확인");
    await taskCard.waitFor({ state: "visible" });
    const transientMutations = await stopProjectMutationObserver(page);
    assert(transientMutations === 0, `일시적 빈 응답이 프로젝트 DOM을 ${transientMutations}회 바꿨습니다.`);

    const runList = page.locator(".v3-run-list");
    const renameRow = runList.locator('[data-session-id="run-alpha-2"]');
    await startRenameMutationObserver(page, "run-alpha-2");
    const renameStartedAt = Date.now();
    await renameRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "이름 변경" }).click();
    await page.getByPlaceholder("세션 이름 (비워두면 기본 이름으로 초기화)").fill("플러시 없는 이름 갱신");
    await page.getByRole("button", { name: "변경", exact: true }).click();
    await waitUntil(async () => (
      (await runList.textContent())?.includes("플러시 없는 이름 갱신") === true
    ), "세션 이름 실시간 갱신");
    const renameVisibleMs = Date.now() - renameStartedAt;
    const renameMutations = await stopRenameMutationObserver(page);
    assert(renameMutations.listChild === 0, `세션 리네임이 리스트 구조를 ${renameMutations.listChild}회 바꿨습니다.`);
    assert(renameMutations.untouched === 0, `세션 리네임이 다른 행을 ${renameMutations.untouched}회 바꿨습니다.`);

    includeThirdRun = true;
    const addStartedAt = Date.now();
    await emitSessionCreated(page);
    await waitUntil(async () => (
      (await page.locator(".v3-runs .v3-detail-section-head").textContent())?.includes("3회") === true
    ), "새 세션 실시간 추가");
    const sessionAddedMs = Date.now() - addStartedAt;

    await page.getByRole("button", { name: "업무 상세 닫기" }).click();
    const projectTask = page.getByTestId("v3-task-task-alpha");
    await projectTask.waitFor({ state: "visible" });
    const removeStartedAt = Date.now();
    await projectTask.click({ button: "right" });
    await page.getByRole("menuitem", { name: "오늘 플래너에서 제거" }).click();
    await projectTask.click({ button: "right" });
    await page.getByRole("menuitem", { name: "오늘 플래너에 추가" }).waitFor({ state: "visible" });
    const todayRemovedMs = Date.now() - removeStartedAt;
    await page.getByRole("menuitem", { name: "오늘 플래너에 추가" }).click();
    await projectTask.click({ button: "right" });
    await page.getByRole("menuitem", { name: "오늘 플래너에서 제거" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    const reviewPanel = page.getByTestId("v3-session-panel");
    const reviewRows = page.getByTestId("v3-session-group-review").locator(".v3-session-row");
    const reviewCountBefore = await reviewRows.count();
    await startReviewMutationObserver(page);
    await reviewRows.first().getByRole("button", { name: /확인 처리$/ }).click();
    await waitUntil(async () => await reviewRows.count() === reviewCountBefore - 1, "검수 행 부분 제거");
    assert(await reviewPanel.isVisible(), "검수 확인 뒤 우측 세션 패널이 닫혔습니다.");
    const reviewMutations = await stopReviewMutationObserver(page);
    assert(reviewMutations.listChild === 1, `검수 확인이 목록 구조를 ${reviewMutations.listChild}회 바꿨습니다.`);
    assert(reviewMutations.untouched === 0, `검수 확인이 남은 행을 ${reviewMutations.untouched}회 바꿨습니다.`);

    return {
      stableWindow,
      liveUpdates: {
        renameVisibleMs,
        sessionAddedMs,
        todayRemovedMs,
        transientMutations,
        renameMutations,
        reviewMutations,
        projectRequests,
        runHistoryRequests,
      },
    };
  } finally {
    await context.close();
  }
}

async function startProjectMutationObserver(page: Page) {
  await page.evaluate(() => {
    const target = document.querySelector(".v3-planner .v3-task-list");
    if (!target) throw new Error("프로젝트 MutationObserver 대상을 찾지 못했습니다.");
    const root = window as Window & { __prArProjectObserver?: { count: number; observer: MutationObserver } };
    const state = { count: 0, observer: null as unknown as MutationObserver };
    state.observer = new MutationObserver((records) => { state.count += records.length; });
    state.observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
    root.__prArProjectObserver = state;
  });
}

async function stopProjectMutationObserver(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const root = window as Window & { __prArProjectObserver?: { count: number; observer: MutationObserver } };
    if (!root.__prArProjectObserver) throw new Error("프로젝트 MutationObserver 상태가 없습니다.");
    root.__prArProjectObserver.observer.disconnect();
    return root.__prArProjectObserver.count;
  });
}

async function startRenameMutationObserver(page: Page, changedSessionId: string) {
  await page.evaluate((sessionId) => {
    const list = document.querySelector(".v3-run-list");
    if (!list) throw new Error("세션 리스트를 찾지 못했습니다.");
    const untouchedRows = [...list.querySelectorAll<HTMLElement>(".v3-run-row")]
      .filter((row) => row.dataset.sessionId !== sessionId);
    const state = {
      listChild: 0,
      untouched: 0,
      observers: [] as MutationObserver[],
    };
    const listObserver = new MutationObserver((records) => { state.listChild += records.length; });
    listObserver.observe(list, { childList: true });
    state.observers.push(listObserver);
    for (const row of untouchedRows) {
      const observer = new MutationObserver((records) => { state.untouched += records.length; });
      observer.observe(row, { attributes: true, characterData: true, childList: true, subtree: true });
      state.observers.push(observer);
    }
    (window as Window & { __prArRenameObserver?: typeof state }).__prArRenameObserver = state;
  }, changedSessionId);
}

async function stopRenameMutationObserver(page: Page): Promise<{ listChild: number; untouched: number }> {
  return await page.evaluate(() => {
    const state = (window as Window & {
      __prArRenameObserver?: { listChild: number; untouched: number; observers: MutationObserver[] };
    }).__prArRenameObserver;
    if (!state) throw new Error("세션 리네임 MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return { listChild: state.listChild, untouched: state.untouched };
  });
}

async function startReviewMutationObserver(page: Page) {
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="v3-session-group-review"] .v3-session-list');
    if (!list) throw new Error("검수 리스트를 찾지 못했습니다.");
    const untouchedRows = [...list.querySelectorAll<HTMLElement>(".v3-session-row")].slice(1);
    const state = { listChild: 0, untouched: 0, observers: [] as MutationObserver[] };
    const listObserver = new MutationObserver((records) => { state.listChild += records.length; });
    listObserver.observe(list, { childList: true });
    state.observers.push(listObserver);
    for (const row of untouchedRows) {
      const observer = new MutationObserver((records) => { state.untouched += records.length; });
      observer.observe(row, { attributes: true, characterData: true, childList: true, subtree: true });
      state.observers.push(observer);
    }
    (window as Window & { __prArReviewObserver?: typeof state }).__prArReviewObserver = state;
  });
}

async function stopReviewMutationObserver(page: Page): Promise<{ listChild: number; untouched: number }> {
  return await page.evaluate(() => {
    const state = (window as Window & {
      __prArReviewObserver?: { listChild: number; untouched: number; observers: MutationObserver[] };
    }).__prArReviewObserver;
    if (!state) throw new Error("검수 MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return { listChild: state.listChild, untouched: state.untouched };
  });
}

async function preparePage(page: Page) {
  await page.addInitScript({ content: `
    window.__name = (target) => target;
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
    const NativeEventSource = window.EventSource;
    const sources = [];
    function RecordedEventSource(url, options) {
      const source = new NativeEventSource(url, options);
      sources.push(source);
      return source;
    }
    RecordedEventSource.prototype = NativeEventSource.prototype;
    RecordedEventSource.CONNECTING = NativeEventSource.CONNECTING;
    RecordedEventSource.OPEN = NativeEventSource.OPEN;
    RecordedEventSource.CLOSED = NativeEventSource.CLOSED;
    window.EventSource = RecordedEventSource;
    window.__prArEventSources = sources;
  ` });
}

async function startMutationObservers(page: Page) {
  await page.evaluate(() => {
    const root = window as Window & {
      __prArMutationState?: {
        counts: { project: number; runHistory: number };
        observers: MutationObserver[];
      };
    };
    const project = document.querySelector(".v3-planner .v3-task-list");
    const runHistory = document.querySelector(".v3-run-list");
    if (!project || !runHistory) throw new Error("MutationObserver 대상을 찾지 못했습니다.");
    const counts = { project: 0, runHistory: 0 };
    const observe = (target: Element, key: keyof typeof counts) => {
      const observer = new MutationObserver((records) => { counts[key] += records.length; });
      observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
      return observer;
    };
    root.__prArMutationState = {
      counts,
      observers: [observe(project, "project"), observe(runHistory, "runHistory")],
    };
  });
}

async function stopMutationObservers(page: Page): Promise<{ project: number; runHistory: number }> {
  return await page.evaluate(() => {
    const root = window as Window & {
      __prArMutationState?: {
        counts: { project: number; runHistory: number };
        observers: MutationObserver[];
      };
    };
    const state = root.__prArMutationState;
    if (!state) throw new Error("MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return state.counts;
  });
}

async function emitSessionUpdated(page: Page, displayName: string) {
  await dispatchSessionEvent(page, "session_updated", {
    type: "session_updated",
    agent_session_id: "run-alpha-2",
    status: "running",
    updated_at: "2026-07-14T01:30:00.000Z",
    display_name: displayName,
  });
}

async function emitRunbookUpdated(page: Page) {
  await dispatchSessionEvent(page, "runbook_updated", {
    type: "runbook_updated",
    runbookId: "rb-alpha",
    boardItemId: "runbook:rb-alpha",
  });
}

async function emitSessionCreated(page: Page) {
  await dispatchSessionEvent(page, "session_created", {
    type: "session_created",
    folder_id: "folder-amber",
    session: {
      agentSessionId: "run-alpha-3",
      status: "running",
      reviewState: "not_required",
      sessionType: "claude",
      createdAt: "2026-07-14T01:35:00.000Z",
      updatedAt: "2026-07-14T01:35:00.000Z",
      displayName: "새 실시간 세션",
      nodeId: "eiaserinnys",
      agentId: "roselin_codex",
      agentName: "로젤린",
    },
  });
}

async function emitCatalogUpdated(page: Page) {
  await dispatchSessionEvent(page, "catalog_updated", {
    type: "catalog_updated",
    catalog: {
      folders: [
        { id: "folder-amber", name: "소울스트림", sortOrder: 0, parentFolderId: null, projectPageId: "project-amber" },
        { id: "folder-ops", name: "Soulstream 운영", sortOrder: 1, parentFolderId: null, projectPageId: "project-ops" },
      ],
      sessions: {},
    },
  });
}

async function dispatchSessionEvent(page: Page, type: string, payload: Record<string, unknown>) {
  await page.evaluate(({ eventType, eventPayload }) => {
    const sources = (window as Window & { __prArEventSources?: EventSource[] }).__prArEventSources ?? [];
    const source = sources.findLast((candidate) => candidate.url.includes("/api/sessions/stream"));
    if (!source) throw new Error("sessions EventSource를 찾지 못했습니다.");
    source.dispatchEvent(new MessageEvent(eventType, { data: JSON.stringify(eventPayload) }));
  }, { eventType: type, eventPayload: payload });
}

function snapshotCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(counts);
}

function plannerDelta(before: Record<string, number>, after: Record<string, number>): number {
  return Object.keys(after)
    .filter((path) => path.startsWith("/api/planner/"))
    .reduce((total, path) => total + (after[path] ?? 0) - (before[path] ?? 0), 0);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}을 확인하지 못했습니다.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
