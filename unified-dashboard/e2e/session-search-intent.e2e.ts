import { expect, test, type Page } from "./test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// 이 파일은 playwright.internal-link-navigation.config.ts가 돌린다. 그 설정의 미리보기
// 서버(4323)가 기본이고, 다른 서버에 대려면 V3_QA_BASE_URL을 준다.
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4323";
const sessionId = "run-alpha-2";

// 폭 760 이하에서 `?session=` 지정을 읽기 전에 채팅 탭을 눌러도 지정한 세션이
// 그 채팅 탭으로 열린다(카드 #1342). 대상 세션 run-alpha-2는 모바일 채팅 탭이
// 기본으로 고르는 folder-amber와 다른 폴더(rb-alpha)에 있다.
test.describe("좁은 폭 채팅 탭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  async function preparePage(page: Page) {
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
    await installV3VisualQaRoutes(page);
    await page.route("**/api/auth/config", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authEnabled: true, devModeEnabled: false }),
    }));
  }

  async function authenticated(page: Page) {
    await page.route("**/api/auth/status", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { email: "qa@example.com", name: "QA" },
      }),
    }));
  }

  async function expectDesignatedSessionChat(page: Page) {
    await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
    await expect(page.locator('[data-slot="chat-root"]').filter({ visible: true }).first()).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeNull();
  }

  // 지정 열기는 세션 한 건 조회(`/api/sessions?session_id=`)를 기다린다. 그 사이에
  // 채팅 탭을 누르는 상황을 만들려고 조회 응답을 잡아 둔다.
  async function holdSessionLookup(page: Page) {
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signal = resolve; });
    await page.route((url) => (
      url.pathname === "/api/sessions" && url.searchParams.has("session_id")
    ), async (route) => {
      signal();
      await gate;
      await route.fallback();
    });
    return { started, release: () => release() };
  }

  test("인증 대기가 끝나자마자 채팅 탭을 눌러도 지정한 세션이 열린다", async ({ page }) => {
    let releaseAuth!: () => void;
    let signalAuthRequest!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    const authRequestStarted = new Promise<void>((resolve) => { signalAuthRequest = resolve; });

    await preparePage(page);
    const lookup = await holdSessionLookup(page);
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

    try {
      await page.goto(`${baseUrl}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
      await authRequestStarted;
      // 인증 대기 중에는 AuthGate가 화면 전체를 스피너로 덮어 탭이 없다. 탭이 생기는
      // 첫 순간(인증이 풀린 직후)에 누르고, 지정 열기는 아직 세션 조회를 기다린다.
      expect(new URL(page.url()).searchParams.get("session")).toBe(sessionId);

      releaseAuth();
      await page.getByTestId("v3-mobile-tab-chat").click();
      lookup.release();

      await expectDesignatedSessionChat(page);
    } finally {
      releaseAuth();
      lookup.release();
    }
  });

  test("세션 한 건 조회를 기다리는 동안 채팅 탭을 눌러도 지정한 세션이 열린다", async ({ page }) => {
    await preparePage(page);
    await authenticated(page);
    const lookup = await holdSessionLookup(page);

    try {
      await page.goto(`${baseUrl}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
      await lookup.started;

      await page.getByTestId("v3-mobile-tab-chat").click();
      lookup.release();

      await expectDesignatedSessionChat(page);
    } finally {
      lookup.release();
    }
  });
});

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
            task_title: "카드 밀도와 계층 최종 QA",
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
    url.pathname === "/api/board-items" && url.searchParams.get("sessionId") === sessionId
  ), (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      boardItems: [{
        id: `session:${sessionId}`,
        folderId: "rb-alpha",
        itemType: "session",
        itemId: sessionId,
        x: 24,
        y: 0,
        metadata: {},
      }],
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

    // 포커스 고리는 2초만 남고, 세션 패널이 그려지기 전에 붙는 회차도 있다. 고리 클래스가
    // 붙는 순간을 config의 expect 대기(15초) 안에서 기다린다(카드 #1460).
    const focusRingAppeared = expect(
      page.locator('[data-tree-node-id$="-42"].chat-focus-ring'),
    ).toHaveCount(1, { timeout: 15_000 });

    await expect.poll(() => targetedSessionRequests.some((query) => (
      new URLSearchParams(query).get("session_id") === sessionId
    ))).toBe(true);
    await expect.poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}${url.hash}`;
    }).toBe("/?keep=1#return");
    await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
    await focusRingAppeared;
    await expect(page.locator('[data-tree-node-id$="-42"]')).toBeInViewport();
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
    await expect(sessionResult).toContainText("카드 밀도와 계층 최종 QA");
    await sessionResult.click();

    await expect(page.locator('[data-tree-node-id$="-7"].chat-focus-ring')).toBeVisible();
    await expect(page.locator('[data-tree-node-id$="-7"]')).toBeInViewport();
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
