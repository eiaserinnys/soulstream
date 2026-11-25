import type { Page, Route } from "@playwright/test";
import type { CardComment, CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { PersistentReportEntry } from "../../packages/wire-schema/src/persistent_report";
import { chatUiSession, installChatUiRoutes } from "./chat-ui-fixtures";
import { buildPasThreadFixture, PAS_THREAD_IDS, type PasThreadFixture } from "../client/v3/pas-report-thread/pas-report-thread-fixtures";

/**
 * 보고 창 화면 시험의 가짜 서버. 운영 웹에 로그인하거나 쿠키를 만들지 않고, 로컬 개발 서버 위에서
 * page.route로 판, 카드 목록과 상세, 답, 커멘트, 상태, 미루기 응답을 채운다.
 */
export interface Call { method: string; path: string; body: Record<string, unknown> | null }
export interface Harness {
  fixture: PasThreadFixture;
  calls: Call[];
  /** 이 카드의 상세 응답을 풀어 줄 때까지 붙든다(로딩 표시를 보려고). */
  holdDetail(cardId: string): () => void;
  /** 이 카드의 상세 응답을 실패시킨다. false로 풀면 다시 정상이다. */
  failDetail(cardId: string, fail: boolean): void;
  /** 판의 장을 바꿔 세션 스트림으로 내보낸다. */
  publishEntries(): Promise<void>;
  /** 카드 상세를 바꾸고 card_updated를 내보낸다. */
  touchCard(cardId: string, change: (detail: CardDetail) => void): Promise<void>;
  callsOf(method: string, pattern: RegExp): Call[];
}

const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: false, show_jev_candidates: true, animate_character: false, show_turn_usage: true, turn_usage_mode: "collapsed" };
const sse = (type: string, payload: object, id: number) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

export async function installThreadScreen(page: Page, options: { fixture?: PasThreadFixture; theme: "light" | "dark" }): Promise<Harness> {
  const fixture = options.fixture ?? buildPasThreadFixture();
  const calls: Call[] = [];
  const held = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  const queue: string[] = [];
  const waiters: (() => void)[] = [];
  let eventId = 100;
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: "reduce" });
  await installChatUiRoutes(page, { ui: false, count: 3 });
  await page.addInitScript(theme => localStorage.setItem("soul-dashboard-theme", theme), options.theme);
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences: { appearance: options.theme }, hasBackground: false } }));

  const resource = () => ({ session_id: chatUiSession, display_name: "보고 검수", node_id: "eiaserinnys", folder_id: "rb-alpha", agent_id: "roselin_codex", agent_name: "로젤린",
    persistent: true, persistent_report: fixture.entries, settings, runtime: { current_model: { model_preset: null, reasoning_effort: null, model: "codex" }, pending: null } });
  await page.route("**/api/persistent-sessions**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      calls.push({ method: "DELETE", path: pathname, body: null });
      fixture.entries = fixture.entries.filter(entry => entry.key !== key);
      return route.fulfill({ json: { ok: true, changed: true, entries: fixture.entries.map(({ key, title }) => ({ key, title })), persistent_report: fixture.entries } });
    }
    if (pathname === "/api/persistent-sessions") return route.fulfill({ json: { sessions: [resource()], total: 1, create_defaults: { node_id: "eiaserinnys", preferred_agent_id: "roselin_codex", settings, initial_instruction: "", unavailable_reason: null } } });
    if (pathname.endsWith("/instructions")) return route.fulfill({ json: { instructions: [] } });
    return route.fulfill({ json: { session: resource() } });
  });
  let streams = 0;
  await page.route("**/api/sessions/stream?*", async route => {
    if (streams++ === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("session_list", { sessions: [{ agentSessionId: chatUiSession, status: "running", eventCount: 3, nodeId: "eiaserinnys", agentId: "roselin_codex" }], total: 1 }, 1) });
    while (!queue.length) await new Promise<void>(resolve => waiters.push(resolve));
    return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + queue.splice(0).join("") });
  });
  let events = 0;
  await page.route("**/api/sessions/*/events*", async route => {
    if (events++ === 0) return route.fulfill({ contentType: "text/event-stream", body: "retry: 100\n\n" + sse("history_sync", { last_event_id: 3, is_live: true, status: "running" }, 3) });
    await new Promise<void>(() => undefined);
  });
  const emit = (type: string, payload: object) => { queue.push(sse(type, payload, ++eventId)); for (const wake of waiters.splice(0)) wake(); };

  const touch = (card: CardRow) => { card.version += 1; card.updatedAt = new Date().toISOString(); };
  const syncCard = (detail: CardDetail) => { fixture.cards[detail.card.id] = detail.card; const index = fixture.list.findIndex(card => card.id === detail.card.id); if (index >= 0) fixture.list[index] = detail.card; };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route(url => url.pathname.startsWith("/api/cards"), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON() as Record<string, unknown>;
    if (url.pathname === "/api/cards") {
      const completed = url.searchParams.get("includeCompleted") === "true";
      return json(route, { cards: fixture.list.filter(card => completed || card.status !== "done") });
    }
    const [, , , rawId, ...rest] = url.pathname.split("/");
    const id = decodeURIComponent(rawId);
    const detail = fixture.details[id];
    if (!detail) return json(route, { detail: { error: { code: "CARD_NOT_FOUND", message: "카드가 없습니다" } } }, 404);
    const suffix = "/" + rest.join("/");
    if (method === "GET" && rest.length === 0) {
      await held.get(id);
      if (failing.has(id)) return json(route, { detail: { error: { code: "SERVER", message: "카드를 불러오지 못했습니다" } } }, 503);
      return json(route, detail);
    }
    calls.push({ method, path: url.pathname, body });
    if (method === "PATCH" && rest.length === 0) {
      const next = body as { snoozedUntil?: string | null; expectedVersion?: number };
      if (next.expectedVersion !== detail.card.version) return json(route, { detail: { error: { code: "VERSION_CONFLICT", message: "카드가 바뀌었습니다" } } }, 409);
      detail.card.snoozedUntil = next.snoozedUntil ?? null;
      touch(detail.card); syncCard(detail);
      return json(route, { card: detail.card });
    }
    if (method === "POST" && suffix === "/comments") {
      const input = body as { body: string; itemId?: number; questionId?: string };
      if (input.itemId !== undefined && input.questionId !== undefined) return json(route, { detail: { error: { code: "BAD_REQUEST", message: "질문 글타래에는 항목을 함께 줄 수 없습니다" } } }, 400);
      const comment: CardComment = { id: `sent-${detail.comments!.length + 1}`, cardId: id, authorKind: "user", authorId: "director", sessionId: null, kind: "comment",
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }), ...(input.questionId === undefined ? {} : { questionId: input.questionId }), body: input.body, createdAt: new Date().toISOString() };
      detail.comments!.push(comment); touch(detail.card);
      return json(route, comment);
    }
    if (method === "POST" && /^\/questions\/[^/]+\/answer$/.test(suffix)) {
      const question = detail.questions.find(item => suffix.includes(item.id));
      const input = body as { mode: "choice" | "text"; option?: string; answer?: string };
      if (question) { question.answer = input.mode === "choice" ? input.option! : input.answer!; question.answeredAt = new Date().toISOString(); }
      touch(detail.card);
      fixture.entries = fixture.entries.map(entry => entry.question_id && question && entry.question_id === question.id ? { ...entry, state: "answered", answer: question.answer ?? "" } : entry);
      return json(route, detail);
    }
    if (method === "POST" && suffix === "/status") {
      const input = body as { status: CardRow["status"]; expectedVersion: number };
      detail.card.status = input.status; touch(detail.card); syncCard(detail);
      fixture.entries = fixture.entries.filter(entry => entry.card_id !== id || input.status === "review");
      if (input.status === "review" && !fixture.entries.some(entry => entry.card_id === id)) fixture.entries.push(buildPasThreadFixture().entries.find(entry => entry.card_id === id)!);
      return json(route, detail);
    }
    return json(route, detail);
  });

  return {
    fixture, calls,
    holdDetail(cardId) {
      let release!: () => void;
      held.set(cardId, new Promise<void>(resolve => { release = () => { held.delete(cardId); resolve(); }; }));
      return release;
    },
    failDetail(cardId, fail) { if (fail) failing.add(cardId); else failing.delete(cardId); },
    async publishEntries() { emit("session_updated", { agent_session_id: chatUiSession, persistent_report: fixture.entries as PersistentReportEntry[] }); },
    async touchCard(cardId, change) { change(fixture.details[cardId]); touch(fixture.details[cardId].card); emit("card_updated", { cardId, folderId: fixture.details[cardId].card.folderId }); },
    callsOf: (method, pattern) => calls.filter(call => call.method === method && pattern.test(call.path)),
  };
}

export { PAS_THREAD_IDS, chatUiSession };
