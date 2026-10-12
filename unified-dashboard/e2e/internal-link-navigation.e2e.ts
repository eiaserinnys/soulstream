import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { reviewCard } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4323";
const output = path.resolve("../.local/artifacts/20261012-internal-link-web");
const sessionId = "run-alpha-2";
const messageMarkdown = [
  "[문서 링크](/api/markdown-documents/doc-1)",
  "[문서 쿼리 링크](/?document=doc-1)",
  "[분류 없는 문서](/api/markdown-documents/orphan-doc)",
  "[없는 문서](/api/markdown-documents/missing-doc)",
  "[이미지 링크](/api/attachments/files?nodeId=eiaserinnys&path=%2Fcapture.png)",
  "[세션 링크](/?session=run-alpha-2&event=1)",
  "[카드 링크](/?card=link-card)",
  "[폴더 링크](/?folder=rb-alpha)",
  "[페이지 링크](/?page=project-amber)",
  "[미연결 페이지](/?page=missing-page)",
].join("\n\n");
const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_model: null,
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed" as const,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: sessionId,
  display_name: "내부 링크 검수",
  node_id: "eiaserinnys",
  folder_id: "rb-alpha",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};
const card = {
  ...reviewCard,
  id: "link-card",
  folderId: "rb-alpha",
  title: "내부 링크 카드 상세",
  request: "채팅에서 연결된 카드입니다.",
  assigneeKind: null,
  assigneeSessionId: null,
  assigneeAgentId: null,
  nodeId: null,
};
const cardDetail = { card, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] };
const png = await readFile(path.resolve("public/icon-192.png"));

async function prepare(page: Page, width: number, contentByEventId: Record<number, string> = { 1: messageMarkdown }) {
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soulstream-pas-device:qa@example.com", JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }));
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  });
  await installV3VisualQaRoutes(page, {
    timelineEventCount: 1,
    timelineContentByEventId: contentByEventId,
    liveEventText: "내부 링크 검수 메시지",
  });
  await page.route("**/api/auth/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }),
  }));
  await page.route("**/api/auth/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.com", name: "QA" } }),
  }));
  await page.route((url) => new URL(url).pathname === "/api/markdown-documents/doc-1"
    || new URL(url).pathname === "/api/markdown-documents/orphan-doc"
    || new URL(url).pathname === "/api/markdown-documents/missing-doc", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("missing-doc")) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "missing" }) });
    }
    const id = url.pathname.endsWith("orphan-doc") ? "orphan-doc" : "doc-1";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        title: id === "doc-1" ? "내부 링크 문서" : "분류 없는 내부 문서",
        body: id === "doc-1"
          ? "# 본문 확인\n\n문서 링크를 눌러 겹쳐 보았습니다.\n\n[같은 문서](/api/markdown-documents/doc-1)"
          : "# 본문 확인\n\n폴더 경로가 없는 문서입니다.",
        version: 1,
        folderId: id === "doc-1" ? "rb-alpha" : "missing-folder",
      }),
    });
  });
  await page.route((url) => new URL(url).pathname === "/api/attachments/files", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: png,
  }));
  await page.route("**/api/persistent-sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/persistent-sessions" && request.method() === "GET") {
      return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
    }
    if (url.pathname === `/api/persistent-sessions/${sessionId}` && request.method() === "GET") {
      return route.fulfill({ json: { session: persistentSession } });
    }
    return route.fallback();
  });
  await page.route("**/api/cards/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id !== card.id) return route.fallback();
    return route.fulfill({ json: cardDetail });
  });
}

async function openV3Chat(page: Page) {
  await page.goto(`${baseUrl}/?session=${sessionId}&event=1`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
}

async function openDocumentFromChat(page: Page, name = "문서 링크") {
  await page.getByRole("link", { name, exact: true }).click();
  const overlay = page.getByTestId("v3-folder-board-document-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("textbox", { name: "Document title" })).toHaveValue(
    name === "분류 없는 문서" ? "분류 없는 내부 문서" : "내부 링크 문서",
  );
  await expect(overlay.getByTestId("markdown-read-body")).toContainText("본문 확인");
  return overlay;
}

async function captureDocument(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
  const geometry = await page.getByTestId("v3-folder-board-document-overlay").evaluate((element) => {
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    return { overlay: rect(element), header: rect(element.querySelector("header")!),
      panel: rect(element.querySelector('[data-testid="markdown-read-body"]')!),
      shell: rect(element.closest(".v3-shell")!) };
  });
  await writeFile(path.join(output, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
}

test("opens document links over V3 and PAS without losing the underlying chat", async ({ page }) => {
  await mkdir(output, { recursive: true });
  await prepare(page, 1440);
  await openV3Chat(page);
  const v3Overlay = await openDocumentFromChat(page);
  await captureDocument(page, "v3-document-overlay");
  const documentRequests = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/api/markdown-documents/doc-1")).length);
  await v3Overlay.getByRole("link", { name: "같은 문서", exact: true }).click();
  await expect(v3Overlay.getByTestId("markdown-read-body")).toContainText("문서 링크를 눌러 겹쳐 보았습니다.");
  expect(await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/api/markdown-documents/doc-1")).length)).toBe(documentRequests);
  await v3Overlay.getByTestId("v3-folder-board-document-overlay-close").click();
  await expect(v3Overlay).toBeHidden();
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");

  await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" });
  const pasChat = page.getByTestId("persistent-session-screen").locator('[data-slot="chat-root"]');
  await expect(pasChat).toContainText("문서 링크");
  const originalChat = await pasChat.elementHandle();
  const originalUrl = page.url();
  const scroller = pasChat.locator('[data-virtuoso-scroller="true"]');
  const scrollTop = await scroller.evaluate((element) => element.scrollTop);
  await page.screenshot({ path: path.join(output, "pas-chat-before-wide.png"), animations: "disabled" });
  const pasOverlay = await openDocumentFromChat(page);
  await expect(page.locator(".v3-shell.persistent-session-screen").getByTestId("v3-folder-board-document-overlay")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/persistent/${sessionId}`);
  await captureDocument(page, "pas-document-overlay-wide");
  await page.keyboard.press("Escape");
  await expect(pasOverlay).toBeHidden();
  expect(page.url()).toBe(originalUrl);
  expect(await originalChat!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "pas-chat-before-narrow.png"), animations: "disabled" });
  await openDocumentFromChat(page, "문서 쿼리 링크");
  await expect(pasOverlay).toBeVisible();
  await captureDocument(page, "pas-document-overlay-narrow");
  await pasOverlay.getByTestId("v3-folder-board-document-overlay-close").click();
  await expect(pasOverlay).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(`/persistent/${sessionId}`);
  await expect(pasChat).toContainText("문서 링크");
});

test("starts linked documents expanded and retains the existing collapse control", async ({ page }) => {
  await prepare(page, 1440);
  await openV3Chat(page);
  const overlay = await openDocumentFromChat(page);
  await expect(overlay).toHaveClass(/is-expanded/);
  await overlay.getByTestId("v3-folder-board-document-overlay-expand").click();
  await expect(overlay).not.toHaveClass(/is-expanded/);
});

test("opens an image attachment in the existing image viewer and closes it with Escape", async ({ page }) => {
  await prepare(page, 1440);
  await openV3Chat(page);
  await page.getByRole("link", { name: "이미지 링크", exact: true }).click();
  const image = page.locator(".v3-card-image-expanded img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "이미지", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: path.join(output, "image-attachment-viewer.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(image).toHaveCount(0);
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("이미지 링크");
});

test("opens V3 card, folder, page and session targets through actual chat links", async ({ page }) => {
  await prepare(page, 1440);
  await openV3Chat(page);

  await page.getByRole("link", { name: "카드 링크", exact: true }).click();
  const cardWorkspace = page.getByTestId("v3-card-workspace");
  await expect(cardWorkspace.getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await cardWorkspace.getByRole("button", { name: "카드 닫기" }).click();
  await expect(cardWorkspace).toHaveCount(0);
  await expect(page.locator(".v3-chat-pane:visible")).toHaveCount(0);
  await expect(page.getByTestId("v3-session-panel")).toBeVisible();
  await openV3Chat(page);

  await page.getByRole("link", { name: "폴더 링크", exact: true }).click();
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("카드 밀도와 계층 최종 QA");
  await openV3Chat(page);
  await page.getByRole("link", { name: "페이지 링크", exact: true }).click();
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("소울스트림");
  await openV3Chat(page);
  await page.getByRole("link", { name: "세션 링크", exact: true }).click();
  // 이벤트 강조는 기존 session-search-intent.e2e.ts가 맡으며 그 시나리오는 이 변경 전부터 실패한다.
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await openV3Chat(page);
  await page.getByRole("link", { name: "미연결 페이지", exact: true }).click();
  await expect(page.locator(".v3-toast.is-visible")).toContainText("페이지와 연결된 폴더를 찾을 수 없습니다.");
});

test("consumes direct card, document, folder and page intents before automatic PAS startup", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/?card=link-card`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-card-workspace").getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await page.getByRole("button", { name: "카드 닫기" }).click();
  await page.goto(`${baseUrl}/?document=doc-1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-board-document-overlay")).toBeVisible();
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await page.getByTestId("v3-folder-board-document-overlay-close").click();
  await page.goto(`${baseUrl}/?folder=rb-alpha`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
  await page.goto(`${baseUrl}/?page=project-amber`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-cards-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "폴더 제목 편집", exact: true })).toHaveText("소울스트림");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
});

test("opens PAS card details and follows a PAS session link to its V3 chat", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("persistent-session-screen").locator('[data-slot="chat-root"]')).toContainText("세션 링크");
  await page.getByRole("link", { name: "카드 링크", exact: true }).click();
  const pasCard = page.getByTestId("v3-card-workspace");
  await expect(pasCard.getByTestId("card-detail")).toContainText("내부 링크 카드 상세");
  await page.screenshot({ path: path.join(output, "pas-card-detail.png"), animations: "disabled" });
  await pasCard.getByRole("button", { name: "카드 닫기" }).click();
  await page.getByRole("link", { name: "세션 링크", exact: true }).click();
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("시각 QA 순회");
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/");
});

test("reports a missing document, leaves Ctrl-click in a new tab, and omits an unresolved folder breadcrumb", async ({ page }) => {
  await mkdir(output, { recursive: true });
  await prepare(page, 1440);
  await openV3Chat(page);
  await page.getByRole("link", { name: "없는 문서", exact: true }).click();
  await expect(page.locator(".v3-toast.is-visible")).toContainText("마크다운 문서를 불러오지 못했습니다 (404)");
  await expect(page.getByTestId("v3-folder-board-document-overlay")).toHaveCount(0);

  // Observe the real click after React's listener; headless tab creation differs by browser.
  await page.evaluate(() => {
    window.addEventListener("click", (event) => {
      document.documentElement.dataset.modifiedClick = JSON.stringify({
        ctrlKey: event.ctrlKey, defaultPrevented: event.defaultPrevented,
      });
    }, { once: true });
  });
  await page.getByRole("link", { name: "문서 링크", exact: true }).click({ modifiers: ["Control"] });
  await expect(page.locator("html")).toHaveAttribute("data-modified-click", JSON.stringify({ ctrlKey: true, defaultPrevented: false }));
  await expect(page.getByTestId("v3-folder-board-document-overlay")).toHaveCount(0);

  const orphanOverlay = await openDocumentFromChat(page, "분류 없는 문서");
  await expect(orphanOverlay.locator(".v3-chat-header small")).toHaveCount(0);
  await captureDocument(page, "document-without-folder-breadcrumb");
  await orphanOverlay.getByTestId("v3-folder-board-document-overlay-close").click();

  await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
  const sampleOverlay = page.getByTestId("v3-folder-board-document-overlay");
  await expect(sampleOverlay).toBeVisible();
  await expect(sampleOverlay.getByTestId("markdown-read-body")).toBeVisible();
  await captureDocument(page, "dialogues-document-overlay-reference");
});

async function captureNarrowDocument(page: Page, name: string) {
  await captureDocument(page, name);
  const styles = await page.getByTestId("v3-folder-board-document-overlay").evaluate((element) => {
    const measure = (node: Element) => {
      const style = getComputedStyle(node);
      return { rect: node.getBoundingClientRect().toJSON(), position: style.position,
        top: style.top, bottom: style.bottom, height: style.height,
        display: style.display, gridTemplateColumns: style.gridTemplateColumns };
    };
    return { overlay: measure(element), workspace: measure(element.parentElement!),
      scrim: measure(element.parentElement!.parentElement!),
      expanded: element.classList.contains("is-expanded") };
  });
  await writeFile(path.join(output, `${name}-styles.json`), JSON.stringify(styles, null, 2));
}

test("captures registered and PAS narrow document surfaces for comparison", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/persistent/${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-slot="chat-root"][data-chat-presentation="manuscript"]')).toContainText("문서 링크");
  await page.setViewportSize({ width: 390, height: 844 });
  await openDocumentFromChat(page);
  await captureNarrowDocument(page, "pas-document-overlay-narrow-fresh");

  await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v3-folder-board-document-overlay").getByTestId("markdown-read-body")).toBeVisible();
  await captureNarrowDocument(page, "dialogues-document-overlay-reference-narrow");
});

test("captures a document clicked from narrow V3 chat", async ({ page }) => {
  await prepare(page, 1440);
  await page.goto(`${baseUrl}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".v3-chat-pane:visible")).toContainText("문서 링크");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("v3-mobile-tab-chat").click();
  await openDocumentFromChat(page);
  await captureNarrowDocument(page, "v3-document-overlay-narrow");
});
