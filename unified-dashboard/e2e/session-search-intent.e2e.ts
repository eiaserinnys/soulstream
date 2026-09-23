import { expect, test } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const sessionId = "run-alpha-2";

test("opens the exact session and event after auth, follows a clicked search result, and labels partial results", async ({ page }, testInfo) => {
  let releaseAuth!: () => void;
  let signalAuthRequest!: () => void;
  const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
  const authRequestStarted = new Promise<void>((resolve) => { signalAuthRequest = resolve; });
  const targetedSessionRequests: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
  });

  await installV3VisualQaRoutes(page, {
    liveEventText: "후속 이벤트",
    timelineEventCount: 42,
  });
  await page.route("**/api/auth/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }),
  }));
  await page.route("**/api/auth/status", async (route) => {
    signalAuthRequest();
    await authGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { email: "qa@example.com", name: "QA" },
      }),
    });
  });
  await page.route("**/cogito/search**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    const searchResults = query === "open the matching work"
      ? {
          results: [],
          navigation_results: [],
          session_results: [{
            session_id: sessionId,
            title: "시각 QA 순회",
            excerpt: "정확한 세션 검색 결과",
            updated_at: "2026-07-14T01:30:00.000Z",
            task_id: "rb-alpha",
            task_title: "업무 카드 밀도와 계층 최종 QA",
            parent_session_id: null,
            best_match: {
              event_id: 7,
              match_source: "message",
              excerpt: "해당 이벤트를 열어 이어서 작업합니다.",
            },
            evidence: [],
            session_url: `/?session=${sessionId}&event=7`,
          }],
          search_status: { search_latency_ms: 12 },
        }
      : {
          results: [],
          navigation_results: [],
          session_results: [],
          search_status: {
            search: { status: "partial", stage: "lexical", reason: "timeout" },
            query_expansion: { status: "partial", reason: "timeout", latency_ms: 3000 },
          },
        };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(searchResults),
    });
  });
  await page.route((url) => (
    url.pathname === "/api/board-items" && url.searchParams.get("session_id") === sessionId
  ), (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      boardItems: [{
        id: `session:${sessionId}`,
        folderId: "folder-amber",
        containerKind: "task",
        containerId: "rb-alpha",
        itemType: "session",
        itemId: sessionId,
        x: 24,
        y: 0,
        metadata: {},
      }],
    }),
  }));
  await page.route("**/api/tasks/rb-alpha", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      task: {
        id: "rb-alpha",
        task_page_id: "task-alpha",
        board_item_id: "task:rb-alpha",
        folder_id: "folder-amber",
        title: "업무 카드 밀도와 계층 최종 QA",
        status: "open",
        archived: false,
        version: 7,
        created_session_id: "session-coordinator",
        created_event_id: 1,
        created_at: "2026-07-13T08:20:00.000Z",
        updated_at: "2026-07-14T01:30:00.000Z",
      },
      sections: [],
      items: [],
    }),
  }));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sessions" && url.searchParams.has("session_id")) {
      targetedSessionRequests.push(url.search);
    }
  });

  try {
    await page.goto(`${baseUrl}/?keep=1&session=${sessionId}&event=42#return`, {
      waitUntil: "domcontentloaded",
    });
    await authRequestStarted;
    await expect.poll(() => targetedSessionRequests.length).toBe(0);
    expect(new URL(page.url()).searchParams.get("session")).toBe(sessionId);

    releaseAuth();

    await expect.poll(() => targetedSessionRequests.some((query) => (
      new URLSearchParams(query).get("session_id") === sessionId
    ))).toBe(true);
    await expect.poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}${url.hash}`;
    }).toBe("/?keep=1#return");
    await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
    await expect(page.locator('[data-tree-node-id$="-42"].chat-focus-ring')).toBeVisible();
    await expect(page.locator(".v3-chat-pane:visible")).toContainText(
      `히스토리 ${sessionId} #42`,
    );
    expect(targetedSessionRequests.some((query) => (
      new URLSearchParams(query).get("session_id") === sessionId
    ))).toBe(true);

    await page.keyboard.press("Control+k");
    const searchInput = page.getByPlaceholder("검색어를 입력하세요...");
    const searchResponse = page.waitForResponse((response) => (
      response.url().includes("/cogito/search")
      && response.request().method() === "GET"
    ));
    await searchInput.fill("phrase with missing expansion");
    await searchResponse;
    await expect(page.getByText("검색을 완료하지 못했습니다. 다시 검색해 주세요.")).toBeVisible();
    await expect(page.getByText("검색 결과가 없습니다")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("search-partial-zero-results.png"),
      fullPage: true,
    });

    const resultSearchResponse = page.waitForResponse((response) => (
      response.url().includes("/cogito/search")
      && response.request().method() === "GET"
    ));
    await searchInput.fill("open the matching work");
    await resultSearchResponse;
    const sessionResult = page.getByTestId("session-search-result");
    await expect(sessionResult).toContainText("업무 카드 밀도와 계층 최종 QA");
    await sessionResult.click();

    await expect(page.locator('[data-tree-node-id$="-7"].chat-focus-ring')).toBeVisible();
    await expect(page.locator(".v3-chat-pane:visible")).toContainText(
      `히스토리 ${sessionId} #7`,
    );
    const input = page.locator('.v3-chat-pane:visible textarea[data-slot="chat-input-body"]').first();
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await input.fill("draft-only acceptance check");
    await expect(input).toHaveValue("draft-only acceptance check");
    await input.fill("");
  } finally {
    releaseAuth();
  }
});
