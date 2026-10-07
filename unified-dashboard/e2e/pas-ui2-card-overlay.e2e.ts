import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { reviewCard, reviewDetail } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../../.local/artifacts/20261007-w6-pas-card-overlay-web");
const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_model: null,
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: "pas-main",
  display_name: "PAS 대화",
  node_id: "eiaserinnys",
  folder_id: null,
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};
const session = {
  agentSessionId: "pas-main",
  displayName: "PAS 대화",
  status: "running",
  eventCount: 1,
  createdAt: "2026-10-06T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  nodeId: "eiaserinnys",
  agentId: "roselin_codex",
  agentName: "로젤린",
  backend: "codex",
  prompt: "검수용 PAS 대화",
};
const assigned = {
  ...reviewCard,
  id: "w6-assigned-card",
  folderId: "folder-amber",
  title: "담당 PAS 카드",
  assigneeSessionId: "pas-main",
  assigneeAgentId: "roselin_codex",
  assigneeKind: "session" as const,
  nodeId: "eiaserinnys",
};
const unassigned = {
  ...assigned,
  id: "w6-unassigned-card",
  title: "담당 없는 카드",
  assigneeSessionId: null,
  assigneeAgentId: null,
  assigneeKind: null,
  nodeId: null,
};

for (const width of [1440, 1280]) {
  test(`PAS card overlay ${width}px`, async ({ page }) => {
    const detail = { ...reviewDetail, card: assigned };
    let pasEventConnections = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/sessions/pas-main/events") pasEventConnections += 1;
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => {
      localStorage.setItem("soul-dashboard-theme", "dark");
      localStorage.setItem("ls.webglGlass", "0");
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
      });
      Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
    });
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: "배경 PAS 대화 메시지" });
    await page.route(url => url.pathname === "/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route(url => url.pathname === "/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
    await page.route(url => url.pathname === "/api/persistent-sessions", route => route.fulfill({
      json: { sessions: [persistentSession], total: 1, create_defaults: { node_id: "eiaserinnys", preferred_agent_id: "roselin_codex", settings, initial_instruction: "", unavailable_reason: null } },
    }));
    await page.route(url => url.pathname === "/api/persistent-sessions/pas-main", route => route.fulfill({ json: { session: persistentSession } }));
    await page.route(url => url.pathname === "/api/sessions/stream", route => route.fulfill({
      contentType: "text/event-stream",
      body: `event: session_list\ndata: ${JSON.stringify({ type: "session_list", sessions: [session], total: 1 })}\n\n`,
    }));
    await page.route(url => url.pathname === "/api/sessions", route => route.fulfill({ json: { sessions: [session], total: 1 } }));
    await page.route(url => url.pathname === "/api/cards", route => route.fulfill({ json: { cards: [assigned, unassigned] } }));
    await page.route(url => url.pathname === `/api/cards/${assigned.id}`, route => route.fulfill({ json: detail }));
    await page.route(url => url.pathname === `/api/cards/${unassigned.id}`, route => route.fulfill({ json: { ...detail, card: unassigned } }));

    mkdirSync(output, { recursive: true });
    await page.goto("/persistent/pas-main");
    const background = page.locator('.persistent-session-main [data-slot="chat-root"][data-chat-presentation="manuscript"]');
    await expect(background).toContainText("배경 PAS 대화 메시지");
    await page.evaluate(() => {
      const root = document.querySelector('[data-slot="chat-root"][data-chat-presentation="manuscript"]')!;
      const scroller = root.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? root;
      (window as any).__w6PasRoot = root;
      (window as any).__w6PasScroller = scroller;
      (window as any).__w6PasScrollTop = scroller.scrollTop;
      (window as any).__w6PasActiveSession = localStorage.getItem("soulstream:persistent-session:last-session-id");
    });
    await page.getByRole("button", { name: "작업 목록", exact: true }).click();
    await expect(page.locator('[data-testid="persistent-session-task-list"] [data-card-id="w6-assigned-card"]')).toBeVisible();
    const beforeClose = await page.screenshot({ path: path.join(output, `${width}-before.png`), animations: "disabled" });
    await page.locator('[data-testid="persistent-session-task-list"] [data-card-id="w6-assigned-card"]').click();
    const workspace = page.getByTestId("v3-card-workspace");
    await expect(workspace).toBeVisible();
    await expect(workspace.locator(".v3-card-workspace-pair > [data-testid='v3-card-workspace-left-divider']")).toBeVisible();
    await expect(workspace.getByTestId("card-detail")).toBeVisible();
    await expect(workspace.getByTestId("v3-card-session-chat").locator('[data-slot="chat-input-body"]')).toBeVisible();
    await expect(workspace.getByTestId("v3-card-session-chat")).toContainText("배경 PAS 대화 메시지");
    await expect(background).toContainText("배경 PAS 대화 메시지");
    expect(pasEventConnections).toBe(1);
    const geometry = await workspace.evaluate(element => {
      const rect = (target: Element) => {
        const box = target.getBoundingClientRect();
        return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, width: box.width, height: box.height };
      };
      return {
        workspace: rect(element),
        detail: rect(element.querySelector('[data-testid="card-detail"]')!),
        conversation: rect(element.querySelector('[data-testid="v3-card-session-chat"]')!),
      };
    });
    expect(Math.abs(geometry.detail.y - geometry.conversation.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.detail.bottom - geometry.conversation.bottom)).toBeLessThanOrEqual(1);
    writeFileSync(path.join(output, `${width}-geometry.json`), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: path.join(output, `${width}-assigned-open.png`), animations: "disabled" });

    await workspace.getByRole("button", { name: "카드 닫기" }).click();
    await expect(workspace).toHaveCount(0);
    const backgroundState = await page.evaluate(() => {
      const root = document.querySelector('[data-slot="chat-root"][data-chat-presentation="manuscript"]');
      const scroller = root?.querySelector<HTMLElement>("[data-virtuoso-scroller]") ?? root;
      return {
        sameRoot: root === (window as any).__w6PasRoot,
        sameScroller: scroller === (window as any).__w6PasScroller,
        before: (window as any).__w6PasScrollTop,
        after: scroller?.scrollTop,
        activeSession: localStorage.getItem("soulstream:persistent-session:last-session-id"),
      };
    });
    expect(backgroundState.sameRoot).toBe(true);
    expect(backgroundState.sameScroller).toBe(true);
    expect(backgroundState.after).toBe(backgroundState.before);
    expect(pasEventConnections).toBe(1);
    const afterClose = await page.screenshot({ path: path.join(output, `${width}-closed.png`), animations: "disabled" });
    expect(afterClose.equals(beforeClose)).toBe(true);

    await page.locator('[data-testid="persistent-session-task-list"] [data-card-id="w6-unassigned-card"]').click();
    await expect(page.getByTestId("v3-card-session-chat")).toContainText("위임 관계에서 세션을 선택하세요.");
    await page.screenshot({ path: path.join(output, `${width}-unassigned-open.png`), animations: "disabled" });
  });
}
