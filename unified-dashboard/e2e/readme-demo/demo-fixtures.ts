import type { Page } from "@playwright/test";
import type { PersistentReportEntry, SessionSummary } from "@seosoyoung/soul-ui";
import type { CardCheckItem, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { PersistentSession, PersistentSessionList } from "../../client/lib/persistent-sessions";

const createdAt = "2026-10-28T08:00:00.000Z";
const updatedAt = "2026-10-28T09:20:00.000Z";
const folderId = "folder-aurora";
const cardIds = {
  running: "card-128",
  review: "card-127",
  question: "card-126",
  queued: "card-125",
  done: "card-124",
};
const sessionIds = {
  running: "session-widget-run",
  review: "session-offline-review",
  writing: "session-notice-copy",
  persistent: "session-advisor",
};
const pageIds = {
  aurora: "page-aurora",
  design: "page-aurora-design",
  qa: "page-aurora-qa",
  blog: "page-blog",
  infra: "page-infra",
  archive: "page-archive",
  daily: "page-daily",
};

const folders = [
  { id: folderId, name: "📱 Aurora 날씨 앱", sortOrder: 0, parentFolderId: null, projectPageId: pageIds.aurora, status: "open", version: 1, archived: false, settings: {} },
  { id: "folder-design", name: "🎨 디자인 시스템", sortOrder: 0, parentFolderId: folderId, projectPageId: pageIds.design, status: "open", version: 1, archived: false, settings: {} },
  { id: "folder-qa", name: "🧪 QA", sortOrder: 1, parentFolderId: folderId, projectPageId: pageIds.qa, status: "open", version: 1, archived: false, settings: {} },
  { id: "folder-blog", name: "📝 기술 블로그", sortOrder: 1, parentFolderId: null, projectPageId: pageIds.blog, status: "open", version: 1, archived: false, settings: {} },
  { id: "folder-infra", name: "🛠️ 인프라", sortOrder: 2, parentFolderId: null, projectPageId: pageIds.infra, status: "open", version: 1, archived: false, settings: {} },
  { id: "folder-archive", name: "📦 보관함", sortOrder: 3, parentFolderId: null, projectPageId: pageIds.archive, status: "open", version: 1, archived: false, settings: {} },
];

function checkItem(id: number, title: string, state: CardCheckItem["state"], result: string | null): CardCheckItem {
  return {
    id, title, state, result, evidence: [], caveat: null, rev: 1, confirmed: null,
    fixOpen: 0, reopened: null, from: null, createdAt, reportedAt: result ? updatedAt : null,
    display: state === "done" ? "reported" : state === "doing" ? "doing" : "todo",
  };
}

function card({
  id, number, title, status, request, items = [], now = null, blockedKind = null, blockedDetail = null,
}: {
  id: string; number: number; title: string; status: CardRow["status"]; request: string;
  items?: CardCheckItem[]; now?: CardRow["now"];
  blockedKind?: CardRow["blockedKind"]; blockedDetail?: string | null;
}): CardRow {
  return {
    id, number, folderId, title, request, brief: request, attachments: [], status,
    blockedKind, blockedDetail, positionKey: `A${String(130 - number).padStart(3, "0")}`,
    queuePositionKey: status === "queued" ? `Q${String(130 - number).padStart(3, "0")}` : null,
    assigneeKind: status === "running" || status === "review" ? "agent" : null,
    assigneeAgentId: status === "running" ? "nova" : status === "review" ? "sage" : null,
    assigneeUserId: null, assigneeSessionId: null,
    nodeId: status === "running" ? "build-linux" : status === "review" ? "studio-mac" : null,
    modelPreset: status === "running" ? "codex-6-luna" : status === "review" ? "codex-6.1-sol" : null,
    version: 1, archived: false, createdAt, updatedAt,
    ...(status === "done" ? { completedAt: updatedAt } : {}),
    items, now,
  };
}

const cards: CardRow[] = [
  card({
    id: cardIds.running, number: 128, title: "위젯에 시간대별 강수 확률 넣기", status: "running",
    request: "홈 화면 위젯에서 시간대별 강수 확률을 한눈에 보여 주세요.",
    items: [checkItem(1, "위젯 데이터 모델 확인", "done", "시간대별 확률 필드를 연결했습니다."), checkItem(2, "좁은 위젯 레이아웃 조정", "doing", null), checkItem(3, "오전·야간 미리보기 확인", "todo", null)],
    now: { text: "iOS 위젯 레이아웃을 맞추는 중", turn: "agent", ask: null, updatedAt, sessionId: sessionIds.running },
  }),
  card({
    id: cardIds.review, number: 127, title: "오프라인에서 마지막 예보 보여 주기", status: "review",
    request: "네트워크가 끊겨도 마지막으로 받은 예보를 읽을 수 있게 해 주세요.",
    items: [checkItem(1, "예보 응답을 로컬에 저장", "done", "예보와 갱신 시각을 함께 저장했습니다."), checkItem(2, "비행기 모드에서 마지막 예보 표시", "done", "오프라인에서도 마지막 예보가 나타납니다."), checkItem(3, "새 예보 수신 뒤 저장값 갱신", "done", "새 응답을 받으면 저장값이 갱신됩니다.")],
    now: { text: "변경 내용을 검수해 주세요", turn: "agent", ask: "비행기 모드에서 앱을 열어 마지막 예보가 보이는지 봐 주세요", updatedAt, sessionId: sessionIds.review },
  }),
  card({
    id: cardIds.question, number: 126, title: "아침 알림 문구 다듬기", status: "blocked",
    request: "아침 예보를 짧고 부드러운 문장으로 알려 주세요.", blockedKind: "question",
    blockedDetail: "발송 시간을 정하면 초안을 마무리할 수 있습니다.",
    items: [checkItem(1, "현재 알림 문구 모으기", "done", "기존 알림 문구 세 가지를 정리했습니다.")],
  }),
  card({
    id: cardIds.queued, number: 125, title: "다크 모드 대비 점검", status: "queued",
    request: "날씨 상태 색상이 어두운 배경에서도 구분되는지 확인합니다.",
  }),
  card({
    id: cardIds.done, number: 124, title: "앱 스토어 스크린샷 갱신", status: "done",
    request: "새 예보 화면을 앱 스토어 이미지에 반영합니다.",
    items: [checkItem(1, "세로 화면 캡처 갱신", "done", "최신 화면을 캡처했습니다.")],
  }),
];

const questions = [{
  id: "question-126-time", text: "아침 알림을 7시와 7시 30분 중 언제 보낼까요?",
  options: ["오전 7시", "오전 7시 30분"], answer: null, askedAt: updatedAt, answeredAt: null,
}];

const sessions: SessionSummary[] = [
  {
    agentSessionId: sessionIds.running, status: "running", eventCount: 6, createdAt, updatedAt,
    displayName: "🔨 위젯 강수 확률 구현", folderId, nodeId: "build-linux", agentId: "nova", agentName: "노바",
    sessionType: "llm", llmProvider: "openai", llmModel: "Codex", backend: "codex",
    modelPreset: "codex-6-luna", reasoningEffort: "max", prompt: "위젯에 시간대별 강수 확률을 보여 주세요.",
    reviewRequired: false, reviewState: "not_required", lastEventId: 6, lastReadEventId: 0, cardId: null,
    lastMessage: { type: "assistant_message", preview: "위젯 폭에 맞춰 두 시간대씩 묶어 표시했습니다.", timestamp: updatedAt },
  },
  {
    agentSessionId: sessionIds.review, status: "completed", eventCount: 5, createdAt, updatedAt, completedAt: updatedAt,
    displayName: "🔍 오프라인 캐시 검수", folderId, nodeId: "studio-mac", agentId: "sage", agentName: "세이지",
    sessionType: "llm", llmProvider: "openai", llmModel: "Codex", backend: "codex",
    modelPreset: "codex-6.1-sol", prompt: "오프라인 예보 복구 흐름을 확인해 주세요.",
    reviewRequired: true, reviewState: "needs_review", lastEventId: 5, lastReadEventId: 0,
    lastMessage: { type: "assistant_message", preview: "저장된 예보와 갱신 시각을 확인했습니다.", timestamp: updatedAt },
  },
  {
    agentSessionId: sessionIds.writing, status: "completed", eventCount: 4, createdAt, updatedAt, completedAt: updatedAt,
    displayName: "✍️ 알림 문구 초안", folderId, nodeId: "studio-mac", agentId: "lyra", agentName: "리라",
    sessionType: "llm", llmProvider: "openai", llmModel: "Codex", backend: "codex",
    modelPreset: "codex-6-luna", prompt: "아침 알림 문구를 짧게 다듬어 주세요.",
    reviewRequired: false, reviewState: "not_required", lastEventId: 4, lastReadEventId: 0,
    lastMessage: { type: "assistant_message", preview: "오늘의 하늘을 먼저 살피고, 우산이 필요하면 알려 드릴게요.", timestamp: updatedAt },
  },
];

const persistentReports: PersistentReportEntry[] = [
  {
    key: "card-127", kind: "see", title: "오프라인 캐시 검수", card_numbers: [127],
    context: "마지막 예보를 저장하고 비행기 모드에서 확인했습니다.", action: "변경 내용을 확인해 주세요.",
    options: [], state: "open", answer: "", updated_at: updatedAt, card_id: cardIds.review, card_status: "review",
  },
  {
    key: "question-126", kind: "ask", title: "아침 알림 발송 시간", card_numbers: [126],
    context: "아침 예보 알림을 준비하고 있습니다.", action: "발송 시간을 골라 주세요.",
    options: ["오전 7시", "오전 7시 30분"], question_id: questions[0]!.id,
    state: "open", answer: "", updated_at: updatedAt, card_id: cardIds.question, card_status: "blocked",
  },
];

const persistentSession: PersistentSession = {
  session_id: sessionIds.persistent, display_name: "비서", node_id: "studio-mac",
  folder_id: folderId, agent_id: "lyra", agent_name: "리라", persistent: true,
  settings: {
    default_model: { model_preset: "codex-6-luna", reasoning_effort: "max" }, fallback_models: [],
    show_generation_separator: true, show_character: false, show_jev_candidates: false,
    show_work_details: true, animate_character: false, turn_usage_mode: "collapsed", show_turn_usage: true,
  },
  runtime: { current_model: { model_preset: "codex-6-luna", reasoning_effort: "max", model: "Codex" }, pending: null },
  persistent_report: persistentReports,
};

const persistentSessionSummary: SessionSummary = {
  agentSessionId: sessionIds.persistent, status: "completed", eventCount: 2, createdAt, updatedAt, completedAt: updatedAt,
  displayName: "비서", folderId, nodeId: "studio-mac", agentId: "lyra", agentName: "리라",
  sessionType: "llm", llmProvider: "openai", llmModel: "Codex", backend: "codex",
  modelPreset: "codex-6-luna", reasoningEffort: "max", prompt: "오늘 작업을 간결하게 정리합니다.",
  reviewRequired: false, reviewState: "not_required", lastEventId: 2, lastReadEventId: 0, cardId: null,
  persistentReport: persistentReports,
  lastMessage: { type: "assistant_message", preview: "오프라인 예보를 검수했고, 알림 문구 초안을 정리했어요.", timestamp: updatedAt },
};

const sessionSummaries: SessionSummary[] = [...sessions, persistentSessionSummary];

const timelineBySession: Record<string, Array<Record<string, unknown>>> = {
  [sessionIds.running]: [
    { id: 1, parent_event_id: null, event_type: "user_message", payload: { text: "위젯에 시간대별 강수 확률을 보여 주세요.", timestamp: 1 }, created_at: createdAt },
    { id: 2, parent_event_id: "1", event_type: "tool_start", payload: { tool_name: "Read", tool_input: { file_path: "src/widgets/HourlyForecast.tsx" }, tool_use_id: "tool-read-widget", timestamp: 2 }, created_at: createdAt },
    { id: 3, parent_event_id: "tool-read-widget", event_type: "tool_result", payload: { result: "시간대별 예보 컴포넌트를 읽었습니다.", tool_use_id: "tool-read-widget", timestamp: 3 }, created_at: createdAt },
    { id: 4, parent_event_id: "1", event_type: "tool_start", payload: { tool_name: "Edit", tool_input: { file_path: "src/widgets/HourlyForecast.tsx" }, tool_use_id: "tool-edit-widget", timestamp: 4 }, created_at: createdAt },
    { id: 5, parent_event_id: "tool-edit-widget", event_type: "tool_result", payload: { result: "위젯 폭에 맞춘 표시를 추가했습니다.", tool_use_id: "tool-edit-widget", timestamp: 5 }, created_at: createdAt },
    { id: 6, parent_event_id: "1", event_type: "assistant_message", payload: { content: "위젯 폭에 맞춰 두 시간대씩 묶어 표시했습니다.\n\n```ts\nconst slots = forecast.slice(0, 6);\n```", timestamp: 6, tool_use_id: "assistant-widget-final", _final_for_live_stream: true }, created_at: updatedAt },
  ],
  [sessionIds.persistent]: [
    { id: 1, parent_event_id: null, event_type: "user_message", payload: { text: "오늘 끝난 것 정리해 줘", timestamp: 1 }, created_at: createdAt },
    { id: 2, parent_event_id: "1", event_type: "assistant_message", payload: { content: "오프라인 예보 저장을 검수했고, 아침 알림 문구 초안을 정리했어요.\n\n다음은 발송 시간을 정하면 됩니다.", timestamp: 2, tool_use_id: "assistant-advisor-final", _final_for_live_stream: true }, created_at: updatedAt },
  ],
  [sessionIds.review]: [
    { id: 1, parent_event_id: null, event_type: "user_message", payload: { text: "오프라인 예보 복구 흐름을 확인해 주세요.", timestamp: 1 }, created_at: createdAt },
    { id: 2, parent_event_id: "1", event_type: "assistant_message", payload: { content: "마지막으로 저장된 예보가 표시되고, 새 응답을 받으면 갱신됩니다.", timestamp: 2, tool_use_id: "assistant-review-final", _final_for_live_stream: true }, created_at: updatedAt },
  ],
};

const nodes = [
  { nodeId: "studio-mac", host: "studio.local", port: 3105, status: "connected", capabilities: {}, connectedAt: Date.parse(createdAt), sessionCount: 3 },
  { nodeId: "build-linux", host: "builder.local", port: 4105, status: "connected", capabilities: {}, connectedAt: Date.parse(createdAt), sessionCount: 1 },
  { nodeId: "gpu-wsl", host: "gpu-box.local", port: 5105, status: "connected", capabilities: {}, connectedAt: Date.parse(createdAt), sessionCount: 0 },
];

function pageDto(id: string, title: string) {
  return { id, title, daily_date: null, version: 1, archived: false, metadata: {}, created_at: createdAt, updated_at: updatedAt };
}

function boardSessionItem(sessionId: string, y: number) {
  return { id: `session:${sessionId}`, folderId, itemType: "session", itemId: sessionId, x: 24, y, metadata: {} };
}

function checkItemQuestionPayload() {
  return { questions, reports: [], sessions: [], comments: [], notes: [], nowHistory: [] };
}

function timeline(sessionId: string) {
  return { messages: timelineBySession[sessionId] ?? [], next_cursor: null };
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type DemoFixtureDiagnostics = {
  registeredApi: string[];
  unregisteredApi: string[];
};

export async function installReadmeDemoRoutes(page: Page, diagnostics: DemoFixtureDiagnostics): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, registered = true) => {
      if (registered) diagnostics.registeredApi.push(`${method} ${path}${url.search}`);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    };
    const stream = (body: string) => {
      diagnostics.registeredApi.push(`${method} ${path}${url.search}`);
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-cache" }, body });
    };

    if (path === "/api/health") return json({ healthy: true, ready: true, draining: false, build_id: "dev" });
    if (path === "/api/auth/config") return json({ authEnabled: false, devModeEnabled: false });
    if (path === "/api/auth/status") return json({ authenticated: true, user: { email: "demo@example.com", name: "날씨 앱 개발자" } });
    if (path === "/api/user/preferences" || path === "/api/user/preferences/sync") return json({
      email: "demo@example.com", preferences: {}, hasBackground: false, backgroundUrl: null,
    });
    if (path === "/api/ui-events/config") return json({ enabled: false });
    if (path === "/api/folders" && method === "GET") {
      return json({ folders: folders.filter((folder) => !folder.archived), sessions: {} });
    }
    const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(path);
    if (folderMatch && method === "GET") {
      const folder = folders.find((entry) => entry.id === decodeURIComponent(folderMatch[1]!));
      return folder ? json({ folder, sections: [], items: [] }) : json({ detail: "folder not found" });
    }
    if (path === "/api/nodes" && method === "GET") return json({ nodes });
    if (path === "/api/nodes/stream") return stream(sse("snapshot", nodes));
    if (/^\/api\/nodes\/[^/]+\/agents$/.test(path)) {
      return json({ agents: [
        { id: "nova", name: "노바", backend: "codex", default_preset: "codex-6-luna", portraitUrl: null },
        { id: "lyra", name: "리라", backend: "codex", default_preset: "codex-6-luna", portraitUrl: null },
        { id: "sage", name: "세이지", backend: "codex", default_preset: "codex-6.1-sol", portraitUrl: null },
      ] });
    }
    if (/^\/api\/nodes\/[^/]+\/agents\/[^/]+\/portrait$/.test(path)) {
      diagnostics.registeredApi.push(`${method} ${path}${url.search}`);
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='32' fill='#6b83db'/><text x='32' y='42' text-anchor='middle' font-size='28' fill='white'>날</text></svg>" });
    }
    if (path === "/api/sessions/stream") {
      return stream(sse("session_list", { type: "session_list", sessions: sessionSummaries, total: sessionSummaries.length }));
    }
    if (path === "/api/sessions/folder-counts") return json({ counts: { [folderId]: sessionSummaries.length } });
    if (path === "/api/sessions" && method === "GET") {
      const requested = url.searchParams.getAll("session_id");
      const reviewOnly = url.searchParams.get("review_state") === "needs_review";
      const rows = sessionSummaries.filter((session) => (!requested.length || requested.includes(session.agentSessionId)) && (!reviewOnly || session.reviewState === "needs_review"));
      return json({ sessions: rows, total: rows.length });
    }
    if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const events = timelineBySession[id] ?? [];
      return stream(`${sse("history_sync", { type: "history_sync", last_event_id: events.length, is_live: true, status: sessionSummaries.find((session) => session.agentSessionId === id)?.status ?? "completed" })}${events.slice(-1).map((entry) => sse(String(entry.event_type), { type: entry.event_type, ...entry.payload as Record<string, unknown>, _final_for_live_stream: true })).join("")}`);
    }
    const timelineMatch = /^\/api\/sessions\/([^/]+)\/timeline$/.exec(path);
    if (timelineMatch) return json(timeline(decodeURIComponent(timelineMatch[1]!)));
    if (path === "/api/planner/today") {
      const plannerFolders = folders.filter((folder) => !folder.parentFolderId).map((folder) => ({
        folder, page: pageDto(folder.projectPageId!, folder.name), itemCounts: {}, itemTotal: 0, completedItemCount: 0, assignee: null,
      }));
      return json({ attention: cards.filter((entry) => entry.status === "review" || entry.status === "blocked"), running: cards.filter((entry) => entry.status === "running"), queued: cards.filter((entry) => entry.status === "queued"), daily: { page: pageDto(pageIds.daily, "오늘"), blocks: [], state_vector: "" }, folders: plannerFolders, memoBlocks: [], reviewSessionIds: sessionSummaries.filter((session) => session.reviewState === "needs_review").map((session) => session.agentSessionId) });
    }
    if (path === "/api/planner/starred-folders") {
      const item = folders.find((folder) => folder.id === folderId)!;
      return json({ items: [{ folder: item, page: pageDto(pageIds.aurora, item.name), itemCounts: { running: 1, review: 1, blocked: 1, queued: 1 }, itemTotal: 5, completedItemCount: 1, assignee: "노바" }], nextCursor: null });
    }
    if (path.startsWith("/api/planner/daily-history")) return json({ dates: [] });
    if (path === `/api/planner/folders/${folderId}?includeCompleted=false` || path === `/api/planner/folders/${folderId}`) {
      const parent = folders.find((folder) => folder.id === folderId)!;
      return json({
        folder: parent, page: pageDto(pageIds.aurora, parent.name), blocks: [],
        cards: cards.filter((entry) => entry.folderId === folderId), sections: [], items: [],
        subfolders: { items: folders.filter((folder) => folder.parentFolderId === folderId), nextCursor: null },
        sessions: { items: sessionSummaries.filter((session) => session.folderId === folderId), nextCursor: null },
      });
    }
    if (path.startsWith("/api/planner/folders/") && path.endsWith("/subfolders")) return json({ items: folders.filter((folder) => folder.parentFolderId === folderId), nextCursor: null });
    if (path.startsWith("/api/planner/folders/") && path.endsWith("/sessions")) return json({ items: sessionSummaries.filter((session) => session.folderId === folderId), nextCursor: null });
    if (path.startsWith("/api/cards") && method === "GET") {
      if (path === "/api/cards") {
        const selected = url.searchParams.get("folderId");
        return json({ cards: cards.filter((entry) => !selected || entry.folderId === selected) });
      }
      const id = path.split("/")[3];
      const selectedCard = cards.find((entry) => entry.id === id);
      return json(selectedCard ? { card: selectedCard, ...checkItemQuestionPayload() } : { error: "카드를 찾을 수 없습니다." });
    }
    if (/^\/api\/pages\/[^/]+\/session-defaults$/.test(path) && method === "GET") {
      const sourcePageId = decodeURIComponent(path.split("/")[3] ?? "");
      return json({ agentId: "nova", nodeId: "build-linux", modelPreset: "codex-6-luna", sourcePageId, sourceBlockId: "session-defaults-demo" });
    }
    if (path === "/api/pages" && method === "GET") {
      return json({ items: folders.map((folder) => pageDto(folder.projectPageId!, folder.name)), next_cursor: null });
    }
    if (path.startsWith("/api/pages/") && method === "GET") {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const page = pageDto(id, folders.find((folder) => folder.projectPageId === id)?.name ?? "Aurora 날씨 앱");
      return json({ page, blocks: [], state_vector: "" });
    }
    if (path === "/api/board-items") {
      const selectedSession = url.searchParams.get("sessionId");
      const selectedFolder = url.searchParams.get("folderId") ?? folderId;
      const matchingSessions = sessionSummaries.filter((session) => session.folderId === selectedFolder
        && (!selectedSession || session.agentSessionId === selectedSession));
      return json({ boardItems: matchingSessions.map((session, index) => boardSessionItem(session.agentSessionId, index * 72)) });
    }
    if (path.startsWith("/api/board/")) return json({ items: [], documents: [] });
    if (path === "/api/persistent-sessions" && method === "GET") {
      const list: PersistentSessionList = {
        sessions: [persistentSession], total: 1,
        create_defaults: { node_id: "studio-mac", preferred_agent_id: "lyra", settings: persistentSession.settings, initial_instruction: "짧고 명확하게 답합니다.", unavailable_reason: null },
      };
      return json(list);
    }
    if (path === `/api/persistent-sessions/${sessionIds.persistent}` && method === "GET") return json({ session: persistentSession });
    if (path === `/api/persistent-sessions/${sessionIds.persistent}/instructions` && method === "GET") return json({ instructions: [] });
    if (path === "/api/usage/summary") return json({
      generatedAt: updatedAt, collectedAt: updatedAt,
      nodes: [{ nodeId: "studio-mac", fetchedAt: updatedAt, stale: false, staleSince: null, providers: {
        codex: { status: "auto", weeklyRemainingPercent: 72, weeklyResetAt: Date.parse("2026-11-02T00:00:00.000Z"), shortRemainingPercent: 88, shortResetAt: Date.parse("2026-10-28T12:00:00.000Z"), quotas: [] },
        claude: { status: "not_configured", weeklyRemainingPercent: null, weeklyResetAt: null, shortRemainingPercent: null, shortResetAt: null, quotas: [] },
        antigravity: { status: "not_configured", weeklyRemainingPercent: null, weeklyResetAt: null, shortRemainingPercent: null, shortResetAt: null, quotas: [] },
      } }],
    });

    const unregistered = `${method} ${path}${url.search}`;
    diagnostics.unregisteredApi.push(unregistered);
    console.warn(`[readme-demo:unregistered-api] ${unregistered}`);
    return json({}, false);
  });
}

export const readmeDemoIds = { folderId, cardIds, sessionIds };
