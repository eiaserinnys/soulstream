import type { Page, Route } from "@playwright/test";

const NOW = "2026-07-14T01:30:00.000Z";
const YESTERDAY = "2026-07-13T08:20:00.000Z";
const LONG_RITUAL_PROMPT = JSON.stringify({
  source: "XOPS",
  instructions: "수집된 원문을 처리하고 결과를 JSON으로 반환한다. ".repeat(160),
  items: Array.from({ length: 24 }, (_, index) => ({
    id: `fixture-${index}`,
    payload: "장문 세션 prompt 회귀 픽스처 ".repeat(12),
  })),
});
const LONG_PROJECT_GUIDANCE = "프로젝트의 결정을 실제 근거와 함께 기록하고, 구현 후 다크·라이트 화면을 모두 검증한다. ".repeat(12).trim();

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
let blockSequence = 0;

export interface V3VisualQaRouteOptions {
  alphaRunHistoryPages?: boolean;
  catalogDelayMs?: number;
  failTaskTitleRenameOnce?: boolean;
  successionPickerRuns?: boolean;
  plannerDelayMs?: number;
  projectResolutionDelayMs?: number;
  projectResolutionMode?: "delayed" | "fail-once" | "unlinked";
  timelineEventCount?: number;
  liveEventText?: string;
  contextMenuParity?: boolean;
  contextChainPreview?: boolean;
  taskDefaultAssignment?: boolean;
  taskContextEditing?: boolean;
  legacyAtomContext?: boolean;
  emptyPlannerProjectsWhen?: () => boolean;
  emptyProjectPlannerWhen?: () => boolean;
  excludeSessionIdsFromInitialStream?: readonly string[];
  includeAlphaThirdRunWhen?: () => boolean;
  includeCreatedTaskWhen?: () => boolean;
  onAgentListRequest?: (nodeId: string) => void;
  onSessionCreate?: (payload: Record<string, unknown>) => void;
  onSessionListRequest?: () => void;
  onPlannerTodayRequest?: (requestNumber: number) => void;
  onPlannerProjectRequest?: (requestNumber: number) => void;
  onRunHistoryRequest?: (requestNumber: number) => void;
  onTaskCreate?: (payload: Record<string, unknown>) => void;
}

function page(
  id: string,
  title: string,
  dailyDate: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    title,
    daily_date: dailyDate,
    version: 4,
    archived: false,
    metadata,
    created_at: YESTERDAY,
    updated_at: NOW,
  };
}

function block(
  id: string,
  pageId: string,
  type: string,
  text: string,
  properties: Record<string, unknown> = {},
  parentId: string | null = null,
) {
  return {
    id,
    page_id: pageId,
    parent_id: parentId,
    position_key: `A${String(++blockSequence).padStart(3, "0")}`,
    block_type: type,
    text,
    properties,
    collapsed: false,
  };
}

const pages = {
  project: page("project-amber", "소울스트림", null, { folderId: "folder-amber" }),
  projectOps: page("project-ops", "Soulstream 운영", null, { folderId: "folder-ops" }),
  projectDashboard: page("project-dashboard", "대시보드", null, { folderId: "folder-dashboard" }),
  today: page("daily-2026-07-14", "2026-07-14", "2026-07-14"),
  yesterday: page("daily-2026-07-13", "2026-07-13", "2026-07-13"),
  taskAlpha: page("task-alpha", "업무 카드 밀도와 계층 최종 QA", null, { starred: true }),
  taskCreated: page("task-created", "PR-CI 생성 직후 fetch 회귀"),
  taskBeta: page("task-beta", "모바일 3탭 선택 상태 검증"),
  taskDone: page("task-done", "완료한 접근성 정리"),
  carryover: page("task-carryover", "이월 업무: 모달 간격 확인"),
  document: page("doc-release", "디자인 검수 메모"),
  documentTwo: page("doc-decisions", "플래너 결정 로그"),
};

const pageReads: Record<string, { page: typeof pages.today; blocks: ReturnType<typeof block>[]; state_vector: string }> = {
  [pages.today.id]: {
    page: pages.today,
    state_vector: "AA==",
    blocks: [
      block("today-memo", pages.today.id, "paragraph", "**아침 배포 전** 시각 QA 결과를 한 번 더 확인한다."),
      block("today-alpha", pages.today.id, "paragraph", `[[${pages.taskAlpha.title}]]`),
      block("today-beta", pages.today.id, "paragraph", `[[${pages.taskBeta.title}]]`),
    ],
  },
  [pages.yesterday.id]: {
    page: pages.yesterday,
    state_vector: "AA==",
    blocks: [
      block("yesterday-carry", pages.yesterday.id, "paragraph", `[[${pages.carryover.title}]]`),
    ],
  },
  [pages.project.id]: {
    page: pages.project,
    state_vector: "AA==",
    blocks: [
      block("project-guidance", pages.project.id, "guidance", LONG_PROJECT_GUIDANCE, { enabled: true, scope: "project" }),
      block("project-atom", pages.project.id, "atom_ref", "", {
        instance: "atom",
        nodeId: "soulstream-project-node",
        nodeTitle: "soulstream",
        depth: 5,
        titlesOnly: false,
      }),
      block("project-defaults", pages.project.id, "session_defaults", "", {
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
        scope: "project",
      }),
      block("project-doc-2", pages.project.id, "paragraph", `[[${pages.documentTwo.title}]]`),
      block("project-done", pages.project.id, "paragraph", `[[${pages.taskDone.title}]]`),
      block("project-carry", pages.project.id, "paragraph", `[[${pages.carryover.title}]]`),
      block("project-doc", pages.project.id, "paragraph", `[[${pages.document.title}]]`),
      block("project-alpha", pages.project.id, "paragraph", `[[${pages.taskAlpha.title}]]`),
      block("project-beta", pages.project.id, "paragraph", `[[${pages.taskBeta.title}]]`),
    ],
  },
  [pages.projectOps.id]: {
    page: pages.projectOps,
    state_vector: "AA==",
    blocks: [],
  },
  [pages.projectDashboard.id]: {
    page: pages.projectDashboard,
    state_vector: "AA==",
    blocks: [],
  },
  [pages.taskAlpha.id]: {
    page: pages.taskAlpha,
    state_vector: "AA==",
    blocks: [
      block("alpha-description", pages.taskAlpha.id, "paragraph", "## 목표\n\n목업 v4.5의 밀도와 계층을 유지하면서 다크·라이트 양쪽을 마감한다."),
      block("alpha-check", pages.taskAlpha.id, "checklist", "가로 오버플로 0", { checked: false }),
      block("alpha-task", pages.taskAlpha.id, "task_ref", "", { taskId: "rb-alpha", primary: true }),
      block("alpha-atom", pages.taskAlpha.id, "atom_ref", "", { instance: "atom", nodeId: "planner-design", title: "플래너 UX 원칙" }),
      block("alpha-guidance", pages.taskAlpha.id, "guidance", "대비와 잘림을 실제 픽셀로 확인", { enabled: true, scope: "session" }),
      block("alpha-defaults", pages.taskAlpha.id, "session_defaults", "", { agentId: "roselin_codex", nodeId: "eiaserinnys", scope: "session" }),
      block("alpha-doc", pages.taskAlpha.id, "paragraph", `[[${pages.document.title}]]`),
    ],
  },
  [pages.taskCreated.id]: {
    page: pages.taskCreated,
    state_vector: "AA==",
    blocks: [
      block("created-description", pages.taskCreated.id, "paragraph", "생성 직후 projection loading 전이를 검증한다."),
      block("created-task", pages.taskCreated.id, "task_ref", "", { taskId: pages.taskCreated.id, primary: true }),
    ],
  },
  [pages.taskBeta.id]: {
    page: pages.taskBeta,
    state_vector: "AA==",
    blocks: [
      block("beta-description", pages.taskBeta.id, "paragraph", "390px에서 오늘·업무·채팅의 선택 상태를 유지한다."),
      block("beta-task", pages.taskBeta.id, "task_ref", "", { taskId: "rb-beta", primary: true }),
      block("beta-guidance", pages.taskBeta.id, "guidance", "손가락으로 누르기 쉬운 탭 크기", { enabled: true, scope: "session" }),
    ],
  },
  [pages.taskDone.id]: {
    page: pages.taskDone,
    state_vector: "AA==",
    blocks: [
      block("done-description", pages.taskDone.id, "paragraph", "키보드 포커스와 라벨을 정리했다."),
      block("done-task", pages.taskDone.id, "task_ref", "", { taskId: "rb-done", primary: true }),
    ],
  },
  [pages.carryover.id]: {
    page: pages.carryover,
    state_vector: "AA==",
    blocks: [
      block("carry-description", pages.carryover.id, "paragraph", "리추얼 모달의 카드·버튼 간격을 마지막으로 확인한다."),
      block("carry-task", pages.carryover.id, "task_ref", "", { taskId: "rb-carry", primary: true }),
    ],
  },
  [pages.document.id]: { page: pages.document, state_vector: "AA==", blocks: [] },
  [pages.documentTwo.id]: { page: pages.documentTwo, state_vector: "AA==", blocks: [] },
};

const allPages = Object.values(pages);

function task(id: string, title: string, statuses: string[], status = "open") {
  return {
    task: {
      id,
      board_item_id: `task:${id}`,
      folder_id: "folder-amber",
      title,
      status,
      archived: false,
      version: 7,
      created_session_id: "session-coordinator",
      created_event_id: 1,
      created_at: YESTERDAY,
      updated_at: NOW,
    },
    sections: [],
    items: statuses.map((itemStatus, index) => ({
      id: `${id}-item-${index + 1}`,
      section_id: `${id}-section`,
      position_key: String(index),
      title: ["시각 순회", "결함 수정", "최종 검증"][index] ?? `항목 ${index + 1}`,
      how_to: "",
      status: itemStatus,
      assignee_kind: "agent",
      assignee_agent_id: "roselin_codex",
      assignee_session_id: null,
      assignee_user_id: null,
      archived: false,
      version: 2,
      created_session_id: "session-coordinator",
      created_event_id: 1,
      updated_session_id: "session-coordinator",
      updated_event_id: 2,
      completed_kind: itemStatus === "completed" ? "agent" : null,
      completed_session_id: itemStatus === "completed" ? "session-coordinator" : null,
      completed_event_id: itemStatus === "completed" ? 2 : null,
      completed_user_id: null,
      completed_at: itemStatus === "completed" ? NOW : null,
      created_at: YESTERDAY,
      updated_at: NOW,
    })),
  };
}

const tasks: Record<string, Json> = {
  [pages.taskCreated.id]: task(pages.taskCreated.id, pages.taskCreated.title, []),
  "rb-alpha": task("rb-alpha", pages.taskAlpha.title, ["completed", "in_progress", "pending"]),
  "rb-beta": task("rb-beta", pages.taskBeta.title, ["completed", "review", "pending"]),
  "rb-done": task("rb-done", pages.taskDone.title, ["completed", "completed"], "completed"),
  "rb-carry": task("rb-carry", pages.carryover.title, ["in_progress", "pending"]),
};

const sessions = [
  {
    agentSessionId: "run-alpha-1",
    folderId: "folder-amber",
    status: "completed",
    reviewState: "acknowledged",
    sessionType: "claude",
    createdAt: "2026-07-13T09:00:00.000Z",
    updatedAt: "2026-07-13T11:20:00.000Z",
    completedAt: "2026-07-13T11:20:00.000Z",
    displayName: "밀도 기준 정리",
    awaySummary: "카드 계층과 간격 토큰을 목업에 맞춰 정리했습니다.",
    lastMessage: {
      type: "assistant",
      preview: "카드 계층과 간격 토큰을 목업에 맞춰 정리했습니다.",
      timestamp: "2026-07-13T11:20:00.000Z",
    },
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-alpha-2",
    folderId: "folder-amber",
    status: "running",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-14T00:30:00.000Z",
    updatedAt: NOW,
    displayName: "시각 QA 순회",
    lastMessage: {
      type: "assistant",
      preview: "다크·라이트 실제 픽셀 순회를 진행하고 있습니다.",
      timestamp: NOW,
    },
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-alpha-3",
    folderId: "folder-amber",
    status: "completed",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-14T01:20:00.000Z",
    updatedAt: "2026-07-14T01:25:00.000Z",
    lastMessage: {
      type: "user_message",
      preview: "🧭 다음 검증은 이전 실행을 골라 이어서 진행해 주세요.",
      timestamp: "2026-07-14T01:25:00.000Z",
    },
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-alpha-child",
    folderId: "folder-amber",
    status: "completed",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-14T00:50:00.000Z",
    updatedAt: "2026-07-14T01:10:00.000Z",
    displayName: "대비 확인",
    awaySummary: "라이트 모드의 입력 영역 대비를 점검했습니다.",
    lastMessage: {
      type: "assistant",
      preview: "라이트 모드의 입력 영역 대비를 점검했습니다.",
      timestamp: "2026-07-14T01:10:00.000Z",
    },
    callerSessionId: "run-alpha-2",
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-beta-1",
    folderId: "folder-amber",
    status: "completed",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T13:15:00.000Z",
    displayName: "모바일 탭 구현",
    awaySummary: "모바일 세 탭의 선택 상태 유지 로직을 구현했습니다.",
    lastMessage: {
      type: "assistant",
      preview: "모바일 세 탭의 선택 상태 유지 로직을 구현했습니다.",
      timestamp: "2026-07-13T13:15:00.000Z",
    },
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "review-session",
    status: "completed",
    reviewRequired: true,
    reviewState: "needs_review",
    sessionType: "claude",
    createdAt: "2026-07-13T18:00:00.000Z",
    updatedAt: "2026-07-13T20:00:00.000Z",
    completedAt: "2026-07-13T20:00:00.000Z",
    prompt: LONG_RITUAL_PROMPT,
    awaySummary: "리다이렉트와 v1 diff 0을 확인했습니다. ".repeat(30),
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  ...Array.from({ length: 5 }, (_, index) => ({
    agentSessionId: `review-session-${index + 2}`,
    status: "completed" as const,
    reviewRequired: true,
    reviewState: "needs_review" as const,
    sessionType: "claude",
    createdAt: `2026-07-13T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
    updatedAt: `2026-07-13T${String(13 + index).padStart(2, "0")}:00:00.000Z`,
    completedAt: `2026-07-13T${String(13 + index).padStart(2, "0")}:00:00.000Z`,
    displayName: `추가 검수 세션 ${index + 2}`,
    awaySummary: `검수 패널 전체 목록 ${index + 2}번 항목입니다.`,
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  })),
];

const runSessions: Record<string, string[]> = {
  [pages.taskCreated.id]: [],
  "rb-alpha": ["run-alpha-1", "run-alpha-2"],
  "rb-beta": ["run-beta-1"],
  "rb-done": [],
  "rb-carry": [],
};

function taskSummary(id: string) {
  const snapshot = tasks[id] as {
    task: Record<string, unknown> & { status: string };
    items: Array<{ status: string; assignee_agent_id: string | null }>;
  };
  const itemCounts = snapshot.items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    ...snapshot.task,
    item_counts: itemCounts,
    item_total: snapshot.items.length,
    completed_item_count: itemCounts.completed ?? 0,
    assignee: snapshot.items.find((item) => item.assignee_agent_id)?.assignee_agent_id ?? null,
  };
}

function plannerTaskPayload(
  taskPage: typeof pages.taskAlpha,
  taskId: string,
  sessionIds: readonly string[] = runSessions[taskId] ?? [],
) {
  return {
    page: taskPage,
    blocks: pageReads[taskPage.id].blocks,
    task_id: taskId,
    task: taskSummary(taskId),
    project_page_id: pages.project.id,
    sessions: sessionIds.slice(-1).map((agentSessionId) => ({ agent_session_id: agentSessionId })),
    mounted_documents: taskPage.id === pages.taskAlpha.id
      ? [{ block_id: "alpha-doc", page: pages.document }]
      : [],
  };
}

function boardItem(itemType: string, itemId: string, taskId: string, y: number, metadata: Record<string, unknown> = {}) {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-amber",
    containerKind: "task",
    containerId: taskId,
    itemType,
    itemId,
    x: 24,
    y,
    metadata,
  };
}

async function fulfillJson(route: Route, body: Json, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function delay(ms: number | undefined): Promise<void> {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function timelinePage(sessionId: string, eventCount: number, before: string | null): Json {
  const upper = before ? Number(before.replace("cursor-", "")) : eventCount;
  const lower = Math.max(1, upper - 99);
  return {
    messages: Array.from({ length: upper - lower + 1 }, (_, index) => {
      const id = upper - index;
      return {
        id,
        parent_event_id: null,
        event_type: "assistant_message",
        payload: {
          timestamp: id,
          content: `히스토리 ${sessionId} #${id}`,
          tool_use_id: `${sessionId}-${id}`,
          _final_for_live_stream: true,
        },
        created_at: new Date(Date.parse(YESTERDAY) + id * 1_000).toISOString(),
      };
    }),
    next_cursor: lower > 1 ? `cursor-${lower - 1}` : null,
  };
}

function sessionEventsBody(sessionId: string, eventCount: number, liveEventText: string): string {
  const liveEventId = eventCount + 1;
  return [
    "event: history_sync",
    `data: ${JSON.stringify({ type: "history_sync", last_event_id: eventCount, is_live: true, status: "running" })}`,
    "",
    `id: ${liveEventId}`,
    "event: assistant_message",
    `data: ${JSON.stringify({
      type: "assistant_message",
      timestamp: liveEventId,
      content: `${liveEventText} ${sessionId}`,
      tool_use_id: `${sessionId}-live`,
      _final_for_live_stream: true,
    })}`,
    "",
    "",
  ].join("\n");
}

export async function installV3VisualQaRoutes(
  pageInstance: Page,
  options: V3VisualQaRouteOptions = {},
): Promise<void> {
  if (options.contextMenuParity) resetContextMenuParityState();
  pageReads[pages.taskBeta.id].blocks = pageReads[pages.taskBeta.id].blocks.filter((item) => item.id !== "beta-cj-atom");
  if (options.legacyAtomContext) {
    pageReads[pages.taskBeta.id].blocks.push(block("beta-cj-atom", pages.taskBeta.id, "atom_ref", "", {
      instance: "atom",
      nodeId: "e6abe00f-3f3f-47ee-9188-c7a6320bd426",
      depth: 3,
      titlesOnly: false,
    }));
  }
  let shouldFailTaskTitleRename = options.failTaskTitleRenameOnce === true;
  let shouldFailProjectResolution = options.projectResolutionMode === "fail-once";
  let plannerTodayRequests = 0;
  let plannerProjectRequests = 0;
  let runHistoryRequests = 0;
  const visiblePages = () => options.includeCreatedTaskWhen?.() === true
    ? allPages
    : allPages.filter((candidate) => candidate.id !== pages.taskCreated.id);
  const alphaRunIds = () => [
    ...runSessions["rb-alpha"],
    ...(options.includeAlphaThirdRunWhen?.() === true ? ["run-alpha-3"] : []),
  ];
  let inlineMarkdownDocument = {
    id: "doc-inline",
    title: "PR-O 결정 로그",
    body: "# 인라인 보드\n\n마크다운 본문은 행을 연 뒤에만 불러옵니다.",
    version: 2,
  };
  await pageInstance.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/auth/config") return fulfillJson(route, { authEnabled: false, devModeEnabled: false });
    if (path === "/api/config") return fulfillJson(route, {
      mode: "orchestrator",
      nodeId: null,
      auth: { enabled: false },
      features: { configModal: true, searchModal: true, nodePanel: true, nodeGuard: false },
    });
    if (path === "/api/config/settings" && request.method() === "GET") {
      return fulfillJson(route, { categories: [] });
    }
    if (path === "/api/folders") return fulfillJson(route, {
      folders: [
        {
          id: "folder-amber",
          name: pages.project.title,
          sortOrder: 0,
          parentFolderId: null,
          projectPageId: options.projectResolutionMode === "unlinked" ? null : pages.project.id,
        },
        ...(options.contextChainPreview ? [{
          id: "folder-dashboard",
          name: pages.projectDashboard.title,
          sortOrder: 0,
          parentFolderId: "folder-amber",
          projectPageId: pages.projectDashboard.id,
        }] : []),
        { id: "folder-ops", name: pages.projectOps.title, sortOrder: 1, parentFolderId: null, projectPageId: pages.projectOps.id },
      ],
      sessions: {},
    });
    const qaNodes = [{
        nodeId: "eiaserinnys",
        host: "localhost",
        port: 3105,
        status: "connected",
        capabilities: {},
        connectedAt: Date.parse(YESTERDAY),
        sessionCount: sessions.length,
      }, ...(options.successionPickerRuns ? [{
        nodeId: "qa-node",
        host: "localhost",
        port: 4105,
        status: "connected",
        capabilities: {},
        connectedAt: Date.parse(YESTERDAY),
        sessionCount: 0,
      }] : [])];
    if (path === "/api/nodes") return fulfillJson(route, { nodes: qaNodes });
    if (path === "/api/nodes/stream") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(qaNodes)}\n\n`,
      });
    }
    if (path === "/api/sessions/stream") {
      const streamedSessions = options.excludeSessionIdsFromInitialStream?.length
        ? sessions.filter(
            (session) => !options.excludeSessionIdsFromInitialStream?.includes(session.agentSessionId),
          )
        : sessions;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: session_list\ndata: ${JSON.stringify({
          type: "session_list",
          sessions: streamedSessions,
          total: streamedSessions.length,
        })}\n\n`,
      });
    }
    if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) {
      const sessionId = decodeURIComponent(path.split("/")[3] ?? "");
      const body = options.liveEventText
        ? sessionEventsBody(sessionId, options.timelineEventCount ?? 0, options.liveEventText)
        : ": empty session\n\n";
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    }
    const timelineMatch = /^\/api\/sessions\/([^/]+)\/timeline$/.exec(path);
    if (timelineMatch && options.timelineEventCount) {
      return fulfillJson(
        route,
        timelinePage(
          decodeURIComponent(timelineMatch[1]),
          options.timelineEventCount,
          url.searchParams.get("before"),
        ),
      );
    }
    if (path === "/api/sessions" && request.method() === "GET") {
      options.onSessionListRequest?.();
      const requestedIds = url.searchParams.getAll("session_id");
      if (requestedIds.length === 0) await delay(options.catalogDelayMs);
      const selectedSessions = requestedIds.length > 0
        ? sessions.filter((session) => requestedIds.includes(session.agentSessionId))
        : sessions;
      return fulfillJson(route, { sessions: selectedSessions, total: selectedSessions.length });
    }
    if (path === "/api/sessions" && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      options.onSessionCreate?.(payload);
      const initialInstruction = typeof payload.initial_instruction === "string"
        ? payload.initial_instruction.trim()
        : "";
      const prompt = [
        "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.",
        initialInstruction,
      ].filter(Boolean).join("\n");
      return fulfillJson(route, {
        agentSessionId: "run-alpha-successor",
        nodeId: payload.nodeId ?? "eiaserinnys",
        prompt,
      });
    }
    const sessionRenameMatch = /^\/api\/sessions\/([^/]+)\/display-name$/.exec(path);
    if (sessionRenameMatch && request.method() === "PATCH") {
      const sessionId = decodeURIComponent(sessionRenameMatch[1]);
      const payload = request.postDataJSON() as { displayName?: string | null };
      const target = sessions.find((session) => session.agentSessionId === sessionId);
      if (!target) return fulfillJson(route, { detail: "session not found" }, 404);
      target.displayName = payload.displayName ?? undefined;
      return fulfillJson(route, { status: "ok" });
    }
    if (path === "/api/sessions/folder-counts") return fulfillJson(route, { counts: {} });
    if (/^\/api\/nodes\/[^/]+\/agents$/.test(path)) {
      const nodeId = decodeURIComponent(path.split("/")[3] ?? "");
      options.onAgentListRequest?.(nodeId);
      return fulfillJson(route, {
        agents: nodeId === "qa-node" ? [{
          id: "qa-agent",
          name: "QA 에이전트",
          backend: "codex",
          portraitUrl: null,
        }] : [{
          id: "roselin_codex",
          name: "로젤린",
          backend: "codex",
          portraitUrl: "/api/nodes/eiaserinnys/agents/roselin_codex/portrait",
        }],
      });
    }
    if (/^\/api\/nodes\/[^/]+\/agents\/[^/]+\/portrait$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#2563eb"/><circle cx="32" cy="25" r="12" fill="#dbeafe"/><path d="M14 57c2-13 10-19 18-19s16 6 18 19" fill="#dbeafe"/></svg>',
      });
    }
    if (path === "/api/pages/daily" && request.method() === "POST") {
      const body = request.postDataJSON() as { date?: string };
      const selected = body.date === "2026-07-13" ? pages.yesterday : pages.today;
      return fulfillJson(route, { page: selected, created: false });
    }
    if (path === "/api/tasks" && request.method() === "POST" && options.onTaskCreate) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      options.onTaskCreate(payload);
      return fulfillJson(route, {
        task: { id: "rb-cj-created", board_item_id: "task:rb-cj-created", folder_id: payload.folder_id, title: payload.title, status: "open", version: 1 },
        task_page: page("task-cj-created", String(payload.title ?? "새 업무")),
        created: true,
      });
    }
    if (path === "/api/planner/today" && request.method() === "GET") {
      plannerTodayRequests += 1;
      options.onPlannerTodayRequest?.(plannerTodayRequests);
      await delay(options.plannerDelayMs);
      const yesterday = url.searchParams.get("date") === "2026-07-13";
      const daily = yesterday ? pageReads[pages.yesterday.id] : pageReads[pages.today.id];
      return fulfillJson(route, {
        daily,
        projects: options.projectResolutionMode || options.emptyPlannerProjectsWhen?.() === true ? [] : [
          pages.project,
          ...(options.contextChainPreview ? [pages.projectDashboard] : []),
          pages.projectOps,
        ],
        tasks: yesterday
          ? [plannerTaskPayload(pages.carryover, "rb-carry")]
          : [
              ...(options.contextMenuParity && !hasDailyTaskMount(pages.taskAlpha.title)
                ? []
                : [{
                    ...plannerTaskPayload(pages.taskAlpha, "rb-alpha", alphaRunIds()),
                    ...(options.contextChainPreview
                      ? { project_page_id: pages.projectDashboard.id }
                      : {}),
                  }]),
              plannerTaskPayload(pages.taskBeta, "rb-beta"),
              ...(options.includeCreatedTaskWhen?.() === true
                ? [plannerTaskPayload(pages.taskCreated, pages.taskCreated.id)]
                : []),
            ],
        memo_blocks: daily.blocks.filter((item) => !item.text.startsWith("[[")),
        review_session_ids: yesterday ? [] : sessions
          .filter((session) => session.reviewState === "needs_review")
          .map((session) => session.agentSessionId),
      });
    }
    if (path === "/api/planner/starred-tasks" && request.method() === "GET") {
      return fulfillJson(route, {
        items: [plannerTaskPayload(pages.taskAlpha, "rb-alpha", alphaRunIds())],
        next_cursor: null,
      });
    }
    if (path === "/api/planner/daily-history" && request.method() === "GET") {
      return fulfillJson(route, { dates: ["2026-07-13"] });
    }
    const plannerTaskRunsMatch = /^\/api\/planner\/tasks\/([^/]+)\/runs$/.exec(path);
    if (plannerTaskRunsMatch && request.method() === "GET") {
      runHistoryRequests += 1;
      options.onRunHistoryRequest?.(runHistoryRequests);
      const taskPageId = decodeURIComponent(plannerTaskRunsMatch[1]);
      if (options.alphaRunHistoryPages && taskPageId === pages.taskAlpha.id) {
        const olderPage = url.searchParams.get("cursor") === "alpha-older";
        return fulfillJson(route, {
          items: [{ agent_session_id: olderPage ? "run-alpha-1" : "run-alpha-2" }],
          next_cursor: olderPage ? null : "alpha-older",
          total: 2,
        });
      }
      const taskId = taskPageId === pages.taskAlpha.id
        ? "rb-alpha"
        : taskPageId === pages.taskBeta.id ? "rb-beta" : taskPageId === pages.taskDone.id ? "rb-done" : "rb-carry";
      const baseIds = taskId === "rb-alpha" ? alphaRunIds() : (runSessions[taskId] ?? []);
      const ids = [...new Set(options.successionPickerRuns && taskId === "rb-alpha"
        ? [...baseIds, "run-alpha-3"]
        : baseIds)].reverse();
      return fulfillJson(route, {
        items: ids.map((agentSessionId) => ({ agent_session_id: agentSessionId })),
        next_cursor: null,
        total: ids.length,
      });
    }
    const plannerProjectMatch = /^\/api\/planner\/projects\/([^/]+)$/.exec(path);
    if (plannerProjectMatch && request.method() === "GET") {
      plannerProjectRequests += 1;
      options.onPlannerProjectRequest?.(plannerProjectRequests);
      await delay(options.plannerDelayMs);
      const empty = options.emptyProjectPlannerWhen?.() === true;
      return fulfillJson(route, {
        project: pages.project,
        tasks: {
          items: empty ? [] : [
            plannerTaskPayload(pages.taskAlpha, "rb-alpha", alphaRunIds()),
            plannerTaskPayload(pages.taskBeta, "rb-beta"),
            plannerTaskPayload(pages.taskDone, "rb-done"),
            plannerTaskPayload(pages.carryover, "rb-carry"),
          ],
          next_cursor: null,
        },
        documents: { items: empty ? [] : [pages.document, pages.documentTwo], next_cursor: null },
      });
    }
    const plannerProjectSliceMatch = /^\/api\/planner\/projects\/([^/]+)\/(tasks|documents)$/.exec(path);
    if (plannerProjectSliceMatch && request.method() === "GET") {
      return plannerProjectSliceMatch[2] === "tasks"
        ? fulfillJson(route, { items: [], next_cursor: null })
        : fulfillJson(route, { items: [], next_cursor: null });
    }
    if (path === "/api/pages" && request.method() === "GET") {
      const items = url.searchParams.get("starred") === "true"
        ? [pages.taskAlpha]
        : visiblePages();
      return fulfillJson(route, { items, next_cursor: null });
    }
    if (path === "/api/pages/search") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      return fulfillJson(route, {
        items: visiblePages()
          .filter((item) => item.title.toLowerCase().includes(query))
          .map((item) => ({ pageId: item.id, title: item.title })),
      });
    }
    const pageMatch = /^\/api\/pages\/([^/]+)$/.exec(path);
    if (pageMatch && request.method() === "GET") {
      const pageId = decodeURIComponent(pageMatch[1]);
      if (pageId === pages.project.id) {
        await delay(options.projectResolutionDelayMs);
        if (shouldFailProjectResolution) {
          shouldFailProjectResolution = false;
          return fulfillJson(route, { detail: "fixture project resolution failure" }, 500);
        }
      }
      const result = pageReads[pageId];
      return result ? fulfillJson(route, result) : fulfillJson(route, { detail: "page not found" }, 404);
    }
    const pageOperationsMatch = /^\/api\/pages\/([^/]+)\/operations$/.exec(path);
    if (pageOperationsMatch && request.method() === "POST") {
      const pageId = decodeURIComponent(pageOperationsMatch[1]);
      const current = pageReads[pageId];
      if (!current) return fulfillJson(route, { detail: "page not found" }, 404);
      const input = request.postDataJSON() as {
        operations?: Array<{
          op?: string;
          title?: string;
          temp_id?: string;
          block_id?: string;
          block_type?: string;
          text?: string;
          properties?: Record<string, unknown>;
          parent_id?: string | null;
        }>;
      };
      const rename = input.operations?.find((operation) => operation.op === "rename_page");
      if (rename?.title && pageId === pages.taskAlpha.id) {
        if (shouldFailTaskTitleRename) {
          shouldFailTaskTitleRename = false;
          return fulfillJson(route, { detail: "fixture rename failure" }, 500);
        }
        pages.taskAlpha.title = rename.title;
        pages.taskAlpha.version += 1;
        const snapshot = tasks["rb-alpha"] as ReturnType<typeof task>;
        snapshot.task.title = rename.title;
        snapshot.task.version += 1;
      }
      const tempIdMapping = Object.fromEntries(
        (input.operations ?? [])
          .filter((operation) => operation.op === "create_block" && operation.temp_id)
          .map((operation) => [operation.temp_id as string, `fixture-${operation.temp_id}`]),
      );
      if (options.contextMenuParity && pageId === pages.today.id) {
        for (const operation of input.operations ?? []) {
          if (operation.op === "delete_block_subtree" && operation.block_id) {
            current.blocks = current.blocks.filter((candidate) => candidate.id !== operation.block_id);
          }
          if (operation.op === "create_block" && operation.temp_id) {
            current.blocks.push(block(
              tempIdMapping[operation.temp_id] ?? operation.temp_id,
              pageId,
              operation.block_type ?? "paragraph",
              operation.text ?? "",
              operation.properties ?? {},
              operation.parent_id ?? null,
            ));
          }
        }
        current.page.version += 1;
      }
      if (options.taskDefaultAssignment && pageId === pages.taskBeta.id) {
        for (const operation of input.operations ?? []) {
          if (operation.op === "create_block" && operation.block_type === "session_defaults") {
            current.blocks.push(block(
              tempIdMapping[operation.temp_id ?? ""] ?? operation.temp_id ?? "fixture-task-defaults",
              pageId,
              "session_defaults",
              "",
              operation.properties ?? {},
              operation.parent_id ?? null,
            ));
          }
          if (operation.op === "update_block_type_and_properties" && operation.block_id) {
            current.blocks = current.blocks.map((candidate) => candidate.id === operation.block_id
              ? { ...candidate, block_type: operation.block_type ?? candidate.block_type, properties: operation.properties ?? {} }
              : candidate);
          }
        }
        current.page.version += 1;
      }
      if (options.taskContextEditing && pageId === pages.taskBeta.id) {
        for (const operation of input.operations ?? []) {
          if (operation.op === "create_block" && operation.temp_id) {
            current.blocks.push(block(
              tempIdMapping[operation.temp_id] ?? operation.temp_id,
              pageId,
              operation.block_type ?? "paragraph",
              operation.text ?? "",
              operation.properties ?? {},
              operation.parent_id ?? null,
            ));
          }
          if (operation.op === "update_block_type_and_properties" && operation.block_id) {
            current.blocks = current.blocks.map((candidate) => candidate.id === operation.block_id
              ? { ...candidate, block_type: operation.block_type ?? candidate.block_type, properties: operation.properties ?? {} }
              : candidate);
          }
          if (operation.op === "delete_block_subtree" && operation.block_id) {
            current.blocks = current.blocks.filter((candidate) => candidate.id !== operation.block_id);
          }
        }
        current.page.version += 1;
      }
      return fulfillJson(route, {
        page: current.page,
        blocks: current.blocks,
        operation: { id: `fixture-operation-${pageId}-${current.page.version}` },
        temp_id_mapping: tempIdMapping,
      });
    }
    if (/^\/api\/pages\/[^/]+\/backlinks$/.test(path)) {
      await delay(options.plannerDelayMs);
      const taskId = decodeURIComponent(path.split("/")[3] ?? "");
      const sourcePageId = [pages.taskAlpha.id, pages.taskBeta.id, pages.taskDone.id, pages.carryover.id].includes(taskId)
        ? pages.project.id
        : null;
      const taskTitle = taskId === pages.taskAlpha.id
        ? pages.taskAlpha.title
        : taskId === pages.taskBeta.id
          ? pages.taskBeta.title
          : taskId === pages.taskDone.id
            ? pages.taskDone.title
            : taskId === pages.carryover.id ? pages.carryover.title : null;
      const dailyMounts = options.contextMenuParity && taskTitle
        ? pageReads[pages.today.id].blocks
            .filter((candidate) => candidate.text === `[[${taskTitle}]]`)
            .map((candidate) => ({
              id: `backlink-daily-${candidate.id}`,
              sourcePageId: pages.today.id,
              sourcePageTitle: pages.today.title,
              sourceBlockId: candidate.id,
              sourceTextPreview: candidate.text,
              linkKind: "mount",
              targetPageId: taskId,
              targetBlockId: null,
              sourceStart: 0,
              sourceEnd: candidate.text.length,
            }))
        : [];
      return fulfillJson(route, {
        items: [
          ...(sourcePageId ? [{
            id: `backlink-${taskId}`,
            sourcePageId,
            sourcePageTitle: pages.project.title,
            sourceBlockId: `mount-${taskId}`,
            sourceTextPreview: taskId,
            linkKind: "mount",
            targetPageId: taskId,
            targetBlockId: null,
            sourceStart: 0,
            sourceEnd: 1,
          }] : []),
          ...dailyMounts,
        ],
        nextCursor: null,
      });
    }
    if (/^\/api\/pages\/[^/]+\/session-defaults$/.test(path)) {
      return fulfillJson(route, {
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
        sourcePageId: pages.project.id,
        sourceBlockId: "project-guidance",
      });
    }
    const reviewAcknowledgeMatch = /^\/api\/sessions\/([^/]+)\/review\/acknowledge$/.exec(path);
    if (reviewAcknowledgeMatch && request.method() === "POST") {
      return fulfillJson(route, {
        status: "ok",
        agentSessionId: decodeURIComponent(reviewAcknowledgeMatch[1]),
        reviewState: "acknowledged",
        changed: true,
      });
    }
    const taskStatusMatch = /^\/api\/tasks\/([^/]+)\/status$/.exec(path);
    if (taskStatusMatch && request.method() === "POST") {
      const snapshot = tasks[decodeURIComponent(taskStatusMatch[1])] as ReturnType<typeof task> | undefined;
      if (!snapshot) return fulfillJson(route, { detail: "task not found" }, 404);
      const payload = request.postDataJSON() as { status?: string };
      snapshot.task.status = payload.status ?? snapshot.task.status;
      snapshot.task.version += 1;
      return fulfillJson(route, { ok: true, snapshot });
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch) {
      await delay(options.plannerDelayMs);
      const snapshot = tasks[decodeURIComponent(taskMatch[1])];
      return snapshot ? fulfillJson(route, snapshot) : fulfillJson(route, { detail: "task not found" }, 404);
    }
    if (path === "/api/board-items") {
      await delay(options.plannerDelayMs);
      if (url.searchParams.has("folder_id")) {
        return fulfillJson(route, {
          boardItems: [
            ...runSessions["rb-alpha"].map((itemId, index) => boardItem("session", itemId, pages.taskAlpha.id, index * 72)),
            ...runSessions["rb-beta"].map((itemId, index) => boardItem("session", itemId, pages.taskBeta.id, index * 72)),
          ],
        });
      }
      const taskId = url.searchParams.get("container_id") ?? "";
      const inlineItems = taskId === "rb-alpha" ? [
        boardItem("markdown", "doc-inline", taskId, 160, {
          title: inlineMarkdownDocument.title,
          version: inlineMarkdownDocument.version,
        }),
        boardItem("custom_view", "view-inline", taskId, 240, { title: "검증 현황" }),
        boardItem("asset", "asset-inline", taskId, 320, { originalName: "context-menu-map.png", sourceUrl: "/context-menu-map.png" }),
      ] : [];
      return fulfillJson(route, {
        boardItems: [
          ...(runSessions[taskId] ?? []).map((itemId, index) => boardItem("session", itemId, taskId, index * 72)),
          ...inlineItems,
        ],
      });
    }
    const boardMoveMatch = /^\/api\/board-items\/([^/]+)\/container$/.exec(path);
    if (boardMoveMatch && request.method() === "PATCH") {
      const boardItemId = decodeURIComponent(boardMoveMatch[1]);
      const sessionId = boardItemId.startsWith("session:") ? boardItemId.slice("session:".length) : boardItemId;
      const body = request.postDataJSON() as { container?: { kind?: string; id?: string } };
      const targetTaskId = body.container?.kind === "task" ? body.container.id : null;
      if (!targetTaskId || !runSessions[targetTaskId]) return fulfillJson(route, { detail: "target not found" }, 404);
      for (const ids of Object.values(runSessions)) {
        const index = ids.indexOf(sessionId);
        if (index >= 0) ids.splice(index, 1);
      }
      runSessions[targetTaskId].push(sessionId);
      return fulfillJson(route, { ok: true, boardItem: boardItem("session", sessionId, targetTaskId, 0) });
    }
    if (path === "/api/markdown-documents/doc-inline") {
      if (request.method() === "PUT") {
        const input = request.postDataJSON() as { title?: string; body?: string; expectedVersion: number };
        if (input.expectedVersion !== inlineMarkdownDocument.version) {
          return fulfillJson(route, { detail: "Document changed elsewhere" }, 409);
        }
        inlineMarkdownDocument = {
          ...inlineMarkdownDocument,
          title: input.title ?? inlineMarkdownDocument.title,
          body: input.body ?? inlineMarkdownDocument.body,
          version: inlineMarkdownDocument.version + 1,
        };
      }
      return fulfillJson(route, inlineMarkdownDocument);
    }
    if (path === "/api/custom-views/view-inline") {
      return fulfillJson(route, {
        id: "view-inline",
        boardItemId: "custom_view:view-inline",
        folderId: "folder-amber",
        title: "검증 현황",
        html: "<main style='font:16px system-ui;padding:16px;color:#172033'><strong>Sandbox custom view</strong><p>4개 메뉴 연결 완료</p></main>",
        revision: 3,
      });
    }

    return fulfillJson(route, { ok: true });
  });
}

function hasDailyTaskMount(title: string): boolean {
  return pageReads[pages.today.id].blocks.some((candidate) => candidate.text === `[[${title}]]`);
}

function resetContextMenuParityState(): void {
  const daily = pageReads[pages.today.id];
  daily.blocks = daily.blocks.filter((candidate) => candidate.text !== `[[${pages.taskAlpha.title}]]`);
  daily.blocks.push(block("today-alpha", pages.today.id, "paragraph", `[[${pages.taskAlpha.title}]]`));
  daily.page.version = 4;
  const alpha = tasks["rb-alpha"] as ReturnType<typeof task>;
  alpha.task.status = "open";
  alpha.task.version = 7;
}

export const fixtureTitles = {
  createdTask: pages.taskCreated.title,
  primaryTask: pages.taskAlpha.title,
  secondaryTask: pages.taskBeta.title,
  carryoverTask: pages.carryover.title,
  project: pages.project.title,
  document: pages.document.title,
};
