import { expect, type Page } from "@playwright/test";
import { renderText } from "@soulstream/chat-ui";
import { reviewDocuments } from "../client/v3/chat-ui-review-documents";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

export const chatUiSession = "run-alpha-2";
export type ChatUiExample = "normal" | "pas" | "gallery";
const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_model: null,
  show_generation_separator: true, show_character: false, show_jev_candidates: true, animate_character: false, show_turn_usage: true };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function sse(type: string, payload: object, id?: number) {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
export async function installChatUiRoutes(page: Page, options: {
  example?: ChatUiExample; count?: number; live?: boolean; questions?: boolean;
  fallback?: "unsupported" | "invalid"; ui?: boolean;
} = {}) {
  const count = options.count ?? 8;
  const example = options.example ?? "normal";
  const doc = reviewDocuments[example];
  const envelope = { schema_version: options.fallback === "unsupported" ? 99 : 1, revision: 1,
    ui_id: "ui_" + "c".repeat(32), hash: "d".repeat(64),
    document: options.fallback === "invalid" ? { schema_version: 1, body: [{ kind: "unknown" }] } : doc };
  const publication = { content: renderText(doc), ui: envelope, timestamp: count };
  const errors: string[] = [], sends: Record<string, unknown>[] = [], responses: { path: string; body: Record<string, unknown> }[] = [];
  const histories: (string | null)[] = [], identities: { sessionId: string; eventId: number; uiId: string; hash: string }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0");
    // A valid registration stub avoids the service-worker-blocked update() error.
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: count });
  await page.route("**/api/config/settings", route => route.fulfill({ json: { categories: [] } }));
  await page.route("**/api/ui-events/config", route => route.fulfill({ json: { enabled: false } }));
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  const sessions = [chatUiSession, "run-alpha-1"].map(session_id => ({ session_id, display_name: "채팅 UI 검수", node_id: "eiaserinnys", folder_id: "rb-alpha", agent_id: "roselin_codex", agent_name: "로젤린", persistent: true, settings,
    runtime: { current_model: { model_preset: null, reasoning_effort: null, model: "codex" }, pending: null } }));
  await page.route("**/api/persistent-sessions**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions, total: 2,
      create_defaults: { node_id: "eiaserinnys", preferred_agent_id: "roselin_codex", settings, initial_instruction: "", unavailable_reason: null } } });
    if (pathname.endsWith("/instructions")) return route.fulfill({ json: { instructions: [] } });
    return route.fulfill({ json: { session: sessions.find(s => pathname.endsWith(s.session_id)) } });
  });
  await page.route("**/api/sessions/*/timeline?*", route => {
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split("/")[3];
    const before = url.searchParams.get("before"); histories.push(before);
    const upper = before ? Number(before) : count;
    const lower = Math.max(1, upper - 99);
    const messages = Array.from({ length: upper - lower + 1 }, (_, index) => {
      const id = upper - index;
      let event_type = "assistant_message";
      let payload: Record<string, unknown> = { content: `기존 일반 답 ${id}\n기존 글과 채팅 흐름을 그대로 유지합니다.`, timestamp: id, tool_use_id: `${sessionId}-${id}` };
      if (id === count && options.ui !== false) {
        payload = publication;
        identities.push({ sessionId, eventId: id, uiId: envelope.ui_id, hash: envelope.hash });
      }
      if (options.questions && id === count - 1) {
        event_type = "input_request";
        payload = { request_id: "qa-question", tool_use_id: "qa-question", started_at: Date.now() / 1000, timeout_sec: 300, timestamp: id,
          questions: [{ question: "기존 질문 경로를 유지할까?", options: [{ label: "유지", description: "기존 응답" }] }] };
      }
      if (options.questions && id === count - 2) {
        event_type = "tool_approval_requested";
        payload = { approval_id: "qa-approval", tool_name: "Read", tool_input: { path: "fixture.txt" }, timestamp: id };
      }
      return { id, parent_event_id: null, event_type, payload, created_at: new Date(id * 1000).toISOString() };
    });
    return route.fulfill({ json: { messages, next_cursor: lower > 1 ? String(lower - 1) : null } });
  });
  const live = gate(), final = gate(), duplicate = gate();
  const summaries = [chatUiSession, "run-alpha-1"].map(agentSessionId => ({ agentSessionId, folderId: "rb-alpha", status: "running", sessionType: "claude",
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z", nodeId: "eiaserinnys", agentId: "roselin_codex", agentName: "로젤린", displayName: "채팅 UI 검수" }));
  let catalogRequests = 0;
  await page.route("**/api/sessions/stream", async route => {
    if (catalogRequests++ === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("session_list", { sessions: summaries, total: 2 }) });
    if (options.live && catalogRequests === 2) {
      await final.promise;
      return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" + sse("session_updated", { agent_session_id: chatUiSession, status: "completed" }) });
    }
    return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n: idle\n\n" });
  });
  const requests = new Map<string, number>();
  await page.route("**/api/sessions/*/events*", async route => {
    const sessionId = new URL(route.request().url()).pathname.split("/")[3];
    const index = requests.get(sessionId) ?? 0; requests.set(sessionId, index + 1);
    if (index === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("history_sync", { last_event_id: count, is_live: true, status: "running" }) });
    if (options.live && sessionId === chatUiSession) {
      if (index === 1) {
        await live.promise;
        return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" +
          sse("text_start", { timestamp: count + 1, tool_use_id: "live-slot", _live_only: true }) +
          sse("text_delta", { timestamp: count + 2, tool_use_id: "live-slot", text: "앞", _live_only: true }) +
          sse("assistant_message", { ...publication, ui: { ...envelope, ui_id: "ui_live" }, timestamp: count + 3 }, count + 1) +
          sse("text_delta", { timestamp: count + 4, tool_use_id: "live-slot", text: "뒤", _live_only: true }) });
      }
      if (index === 2) {
        await final.promise;
        return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" +
          sse("assistant_message", { timestamp: count + 5, tool_use_id: "live-slot", content: "앞뒤 최종 답", _final_for_live_stream: true }, count + 2) +
          sse("complete", { timestamp: count + 6, success: true }, count + 3) });
      }
      if (index === 3) {
        await duplicate.promise;
        return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" + sse("assistant_message", publication, count) });
      }
    }
    return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" + sse("history_sync", { last_event_id: count, is_live: true, status: "running" }) });
  });
  let releaseUpload = () => {};
  let holdUpload = false;
  await page.route("**/api/attachments/sessions?*", async route => {
    if (holdUpload) await new Promise<void>(resolve => { releaseUpload = resolve; });
    return route.fulfill({ json: { path: "/fixture/메모.pdf" } });
  });
  await page.route("**/api/sessions/*/intervene", route => {
    sends.push(route.request().postDataJSON()); return route.fulfill({ json: { delivered: true } });
  });
  await page.route(/\/api\/sessions\/[^/]+\/(respond|tool-approvals\/[^/]+\/approve)$/, route => {
    responses.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  let sourceRequests = 0;
  await page.context().route("https://www.openui.com/**", route => {
    sourceRequests++; return route.fulfill({ contentType: "text/html", body: "<title>출처 검수</title>" });
  });
  return { errors, sends, responses, histories, identities, doc,
    releaseLive: live.release, releaseFinal: final.release, releaseDuplicate: duplicate.release,
    holdUpload: () => { holdUpload = true; }, releaseUpload: () => { holdUpload = false; releaseUpload(); }, sourceRequests: () => sourceRequests };
}

export async function openChatUi(page: Page, pas = false) {
  await page.goto(pas ? `/persistent/${chatUiSession}` : `/?session=${chatUiSession}`);
  if (!pas && (page.viewportSize()?.width ?? 1440) <= 760) await page.getByTestId("v3-mobile-tab-chat").click();
  const root = page.locator('[data-slot="chat-root"]').filter({ visible: true }).first();
  await expect(root).toBeVisible();
  await expect(root.locator(".chat-ui").first()).toBeVisible();
  return root;
}
