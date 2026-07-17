import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AN_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-context-chain-preview"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-an-v3-context-chain-preview",
  timeoutMs: 120_000,
}, async ({ browser }) => verify(browser));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verify(browser: Browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const pageReads = new Map<string, number>();
  const createPayloads: Record<string, unknown>[] = [];
  let plannerTodayRequests = 0;
  let emptyPlannerProjects = false;

  page.on("request", (request) => {
    const pathName = new URL(request.url()).pathname;
    if (["/api/pages/project-amber", "/api/pages/project-dashboard"].includes(pathName)) {
      pageReads.set(pathName, (pageReads.get(pathName) ?? 0) + 1);
    }
  });
  await preparePage(page);
  await installV3VisualQaRoutes(page, {
    contextChainPreview: true,
    emptyPlannerProjectsWhen: () => emptyPlannerProjects,
    onPlannerTodayRequest: (requestNumber) => { plannerTodayRequests = requestNumber; },
    onSessionCreate: (payload) => { createPayloads.push(payload); },
  });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "새 업무" }).click();
    await page.getByLabel("프로젝트 선택").selectOption("folder-dashboard");

    const preview = page.getByTestId("new-task-inheritance-preview");
    const guidance = page.getByTestId("inheritance-guidance-preview");
    await waitText(preview, "컨텍스트 미리보기 · 대시보드", "컨텍스트 미리보기");
    await waitText(guidance, "프로젝트의 결정을 실제 근거와 함께 기록하고", "부모 guidance");
    await waitText(page.getByTestId("inheritance-guidance"), "소울스트림에서 상속", "부모 출처");
    assert(await preview.locator("details").count() === 0, "guidance 접기 UI가 남았습니다.");
    assert(await guidance.evaluate((element) => getComputedStyle(element).webkitLineClamp) === "3", "guidance가 공통 3줄 clamp를 쓰지 않습니다.");
    await waitUntil(() => (pageReads.get("/api/pages/project-amber") ?? 0) === 1, "부모 프로젝트 페이지 1회 조회");
    await waitUntil(() => (pageReads.get("/api/pages/project-dashboard") ?? 0) === 1, "선택 프로젝트 페이지 1회 조회");
    await capture(page, "01-parent-chain-preview");

    await page.getByRole("button", { name: "취소", exact: true }).click();
    await page.getByRole("heading", { name: "새 업무", exact: true }).waitFor({ state: "detached" });
    await page.getByTestId("v3-task-task-alpha").click();
    try {
      await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }).waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      console.error(`[pr-an/qa] 업무 진입 실패 · ${(await page.locator("body").textContent() ?? "").slice(0, 2_000)}`);
      await capture(page, "diagnostic-task-open-failure");
      throw error;
    }
    const detailContext = page.locator(".v3-detail-section").filter({ has: page.getByRole("heading", { name: "정보" }) });
    await waitText(detailContext, "프로젝트의 결정을 실제 근거와 함께 기록하고", "업무 상세 부모 guidance");
    await waitText(detailContext, "플래너 UX 원칙", "업무 상세 자체 atom");

    await page.getByRole("button", { name: "＋ 새 세션" }).click();
    const modal = page.locator(".v3-succession-modal");
    await waitText(modal, "프로젝트의 결정을 실제 근거와 함께 기록하고", "승계 모달 부모 guidance");
    await waitText(modal, "플래너 UX 원칙", "승계 모달 자체 atom");
    await capture(page, "02-shared-detail-and-succession-context");
    await page.getByRole("button", { name: "시작", exact: true }).click();
    await page.getByRole("heading", { name: "새 세션", exact: true }).waitFor({ state: "detached" });

    const createPayload = createPayloads.at(-1);
    const contextItems = Array.isArray(createPayload?.extra_context_items)
      ? createPayload.extra_context_items as Record<string, unknown>[]
      : [];
    const marker = contextItems.find((item) => item.key === "page_context_sources");
    assert(marker, "세션 생성 요청에 page_context_sources가 없습니다.");
    assert(JSON.stringify(marker.content) === JSON.stringify({
      pages: [
        { page_id: "project-amber" },
        { page_id: "project-dashboard" },
        { page_id: "task-alpha" },
      ],
    }), `세션 생성 source 체인이 다릅니다: ${JSON.stringify(marker.content)}`);

    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.locator(".v3-workspace-scrim").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "새 업무" }).click();
    await page.getByLabel("프로젝트 선택").selectOption("folder-dashboard");
    const refreshedPreview = page.getByTestId("new-task-inheritance-preview");
    const refreshedGuidance = page.getByTestId("inheritance-guidance-preview");
    await waitText(refreshedGuidance, "프로젝트의 결정을 실제 근거와 함께 기록하고", "refetch 전 부모 guidance");
    const requestsBeforeCatalog = plannerTodayRequests;
    emptyPlannerProjects = true;
    await emitCatalogUpdated(page);
    await page.waitForTimeout(500);
    assert(
      plannerTodayRequests === requestsBeforeCatalog,
      `catalog_updated가 planner를 광역 재조회했습니다: ${requestsBeforeCatalog} → ${plannerTodayRequests}`,
    );
    await waitText(refreshedGuidance, "프로젝트의 결정을 실제 근거와 함께 기록하고", "refetch 뒤 유지된 guidance");
    assert(!(await refreshedPreview.textContent() ?? "").includes("컨텍스트 없음"), "일시적 빈 목록을 EMPTY로 오진했습니다.");
    await capture(page, "03-preview-retained-after-catalog-refetch");

    return {
      plannerTodayRequests,
      catalogPlannerRefetches: plannerTodayRequests - requestsBeforeCatalog,
      pageReads: Object.fromEntries(pageReads),
      retainedAfterEmptyPlannerProjects: true,
      sessionContextSourcePageIds: (marker.content as { pages: Array<{ page_id: string }> }).pages
        .map((source) => source.page_id),
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page) {
  await page.addInitScript({ content: `
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
    window.__prAnEventSources = sources;
  ` });
}

async function emitCatalogUpdated(page: Page) {
  await page.evaluate(() => {
    const sources = (window as Window & { __prAnEventSources?: EventSource[] }).__prAnEventSources ?? [];
    const source = sources.findLast((candidate) => candidate.url.includes("/api/sessions/stream"));
    if (!source) throw new Error("sessions EventSource를 찾지 못했습니다.");
    source.dispatchEvent(new MessageEvent("catalog_updated", {
      data: JSON.stringify({
        type: "catalog_updated",
        catalog: {
          folders: [
            { id: "folder-amber", name: "소울스트림", sortOrder: 0, parentFolderId: null, projectPageId: "project-amber" },
            { id: "folder-dashboard", name: "대시보드", sortOrder: 0, parentFolderId: "folder-amber", projectPageId: "project-dashboard" },
            { id: "folder-ops", name: "Soulstream 운영", sortOrder: 1, parentFolderId: null, projectPageId: "project-ops" },
          ],
          sessions: {},
        },
      }),
    }));
  });
}

async function waitText(locator: Locator, expected: string, label: string) {
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  await waitUntil(async () => (await locator.textContent())?.includes(expected) === true, label);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}을 확인하지 못했습니다.`);
}

async function capture(page: Page, name: string) {
  await page.waitForTimeout(150);
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({
    path: path.join(outputRoot, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
