import type { Page, Route } from "@playwright/test";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { PersistentSessionList } from "../client/lib/persistent-sessions";

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
  postitCards?: CardRow[];
  unifiedFolderView?: boolean;
  nestedSubfolder?: boolean;
  alphaRunHistoryPages?: boolean;
  catalogDelayMs?: number;
  failTaskTitleRenameOnce?: boolean;
  successionPickerRuns?: boolean;
  plannerDelayMs?: number;
  projectResolutionDelayMs?: number;
  projectResolutionMode?: "delayed" | "fail-once" | "unlinked";
  timelineEventCount?: number;
  timelineContentByEventId?: Readonly<Record<number, string>>;
  liveEventText?: string;
  contextMenuParity?: boolean;
  contextChainPreview?: boolean;
  taskDefaultAssignment?: boolean;
  taskAssignmentModelPreset?: string;
  taskContextEditing?: boolean;
  legacyAtomContext?: boolean;
  outsideTaskSession?: boolean;
  sessionModelPresets?: Readonly<Record<string, string | null>>;
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
  abortUnknownApiRoutes?: boolean;
  onUnknownApiRequest?: (method: string, path: string) => void;
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
  taskAlpha: page("task-alpha", "카드 밀도와 계층 최종 QA", null, { starred: true }),
  taskCreated: page("task-created", "PR-CI 생성 직후 fetch 회귀"),
  taskBeta: page("task-beta", "모바일 3탭 선택 상태 검증"),
  taskDone: page("task-done", "완료한 접근성 정리"),
  carryover: page("task-carryover", "이월 폴더: 모달 간격 확인"),
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
      block("project-done", pages.project.id, "paragraph", `[[${pages.taskDone.title}]]`),
      block("project-carry", pages.project.id, "paragraph", `[[${pages.carryover.title}]]`),
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
      block("beta-description", pages.taskBeta.id, "paragraph", "390px에서 오늘·폴더·채팅의 선택 상태를 유지한다."),
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
    folderId: "rb-alpha",
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
    folderId: "rb-alpha",
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
    folderId: "rb-alpha",
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
    folderId: "rb-alpha",
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
    folderId: "rb-beta",
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

const outsideTaskSession = {
  agentSessionId: "run-outside-task",
  folderId: "folder-amber",
  status: "running" as const,
  reviewState: "not_required" as const,
  sessionType: "claude",
  createdAt: "2026-07-14T01:29:00.000Z",
  updatedAt: NOW,
  displayName: "데일리 밖 완료 폴더 세션",
  lastMessage: {
    type: "assistant",
    preview: "완료 폴더의 소속을 canonical membership으로 찾습니다.",
    timestamp: NOW,
  },
  nodeId: "eiaserinnys",
  agentId: "roselin_codex",
  agentName: "로젤린",
};

const runSessions: Record<string, string[]> = {
  [pages.taskCreated.id]: [],
  "rb-alpha": ["run-alpha-1", "run-alpha-2"],
  "rb-beta": ["run-beta-1"],
  "rb-done": [],
  "rb-carry": [],
};

function fixtureFolder(id: string, folderPage: typeof pages.taskAlpha, parentFolderId: string | null) {
  const snapshot = tasks[id] as ReturnType<typeof task> | undefined;
  return {
    id, name: folderPage.title, parentFolderId, sortOrder: 0, projectPageId: folderPage.id,
    status: snapshot?.task.status ?? "open", archived: false,
    version: snapshot?.task.version ?? 1, settings: {},
  };
}

function plannerFolderPayload(folder: ReturnType<typeof fixtureFolder>, folderPage: typeof pages.taskAlpha) {
  const snapshot = tasks[folder.id] as ReturnType<typeof task> | undefined;
  const counts = (snapshot?.items ?? []).reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  return {
    folder, page: folderPage,
    itemCounts: counts,
    itemTotal: snapshot?.items.length ?? 0,
    completedItemCount: counts.completed ?? 0,
    assignee: snapshot?.items.find((item) => item.assignee_agent_id)?.assignee_agent_id ?? null,
  };
}

function boardItem(itemType: string, itemId: string, folderId: string, y: number, metadata: Record<string, unknown> = {}) {
  return {
    id: `${itemType}:${itemId}`,
    folderId,
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

function timelinePage(
  sessionId: string,
  eventCount: number,
  before: string | null,
  contentByEventId?: Readonly<Record<number, string>>,
): Json {
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
          content: contentByEventId?.[id] ?? `히스토리 ${sessionId} #${id}`,
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
  pageReads[pages.taskAlpha.id].page.metadata.starred = true;
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
  const baseQaSessions = options.unifiedFolderView
    ? [...sessions, outsideTaskSession, ...Array.from({ length: 48 }, (_, index) => ({
        ...outsideTaskSession,
        agentSessionId: `folder-history-${index + 1}`,
        displayName: `폴더 세션 ${index + 1}`,
        createdAt: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
        updatedAt: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
      }))]
    : options.outsideTaskSession ? [...sessions, outsideTaskSession] : sessions;
  const qaSessions = baseQaSessions.map((session) => {
    if (!Object.hasOwn(options.sessionModelPresets ?? {}, session.agentSessionId)) {
      return session;
    }
    return {
      ...session,
      modelPreset: options.sessionModelPresets?.[session.agentSessionId] ?? null,
    };
  });
  const unifiedFolders = [
    fixtureFolder("folder-amber", pages.project, null),
    fixtureFolder("folder-dashboard", pages.projectDashboard, "folder-amber"),
    fixtureFolder("folder-ops", pages.projectOps, null),
    fixtureFolder("rb-alpha", pages.taskAlpha, "folder-amber"),
    fixtureFolder("rb-beta", pages.taskBeta, options.nestedSubfolder ? "folder-dashboard" : "folder-amber"),
    fixtureFolder("rb-done", pages.taskDone, "folder-amber"),
    fixtureFolder("rb-carry", pages.carryover, "folder-amber"),
    ...(options.includeCreatedTaskWhen?.() === true
      ? [fixtureFolder(pages.taskCreated.id, pages.taskCreated, "folder-amber")] : []),
  ];
  const folderPageById = new Map([
    ["folder-amber", pages.project], ["folder-dashboard", pages.projectDashboard],
    ["folder-ops", pages.projectOps], ["rb-alpha", pages.taskAlpha],
    ["rb-beta", pages.taskBeta], ["rb-done", pages.taskDone],
    ["rb-carry", pages.carryover], [pages.taskCreated.id, pages.taskCreated],
  ]);
  const unifiedSection = { id: "section-amber", folderId: "folder-amber", positionKey: "a",
    title: "진행", archived: false, version: 1, assigneeKind: null, assigneeAgentId: null,
    assigneeSessionId: null, assigneeUserId: null, createdSessionId: null, createdEventId: null,
    updatedSessionId: null, updatedEventId: null, createdAt: NOW, updatedAt: NOW };
  const unifiedItem = { id: "item-amber", sectionId: "section-amber", positionKey: "a",
    title: "화면 점검", howTo: "", status: "pending", archived: false, version: 1,
    assigneeKind: null, assigneeAgentId: null, assigneeSessionId: null, assigneeUserId: null,
    createdSessionId: null, createdEventId: null, updatedSessionId: null, updatedEventId: null,
    completedKind: null, completedSessionId: null, completedEventId: null,
    completedUserId: null, completedAt: null, createdAt: NOW, updatedAt: NOW };
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
  let inlineMarkdownTaskId: string | null = "rb-alpha";
  await pageInstance.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (/^\/api\/sessions\/[^/]+\/resume-after-limit$/.test(path)
      && request.method() === "GET") {
      return fulfillJson(route, {
        eligible: false,
        reason: "사용량 제한으로 중단된 세션이 아닙니다.",
        resets_at: null,
        schedule: null,
      });
    }

    if (/^\/api\/sessions\/[^/]+\/resume-after-limit$/.test(path)
      && request.method() === "POST") {
      return fulfillJson(route, {
        schedule_id: "resume-after-limit:session-alpha:32:0",
        run_at: "2026-09-28T11:00:00.000Z",
        status: "active",
        reused: false,
      });
    }

    if (path === "/api/health") return fulfillJson(route, {
      healthy: true, ready: true, draining: false, build_id: "dev",
    });
    if (path === "/api/auth/config") return fulfillJson(route, { authEnabled: false, devModeEnabled: false });
    if (path === "/api/auth/status") return fulfillJson(route, { authenticated: true, user: null });
    if (path === "/api/persistent-sessions" && request.method() === "GET") {
      return fulfillJson(route, {
        sessions: [], total: 0,
        create_defaults: {
          node_id: "eiaserinnys", preferred_agent_id: "seosoyoung",
          settings: {
            default_model: { model_preset: null, reasoning_effort: null },
            fallback_model: null, show_generation_separator: true,
            show_character: true, animate_character: true,
            show_jev_candidates: true, show_turn_usage: true,
          },
          initial_instruction: "검수용 영구 세션", unavailable_reason: null,
        },
      } satisfies PersistentSessionList);
    }
    if (path === "/api/cards" && request.method() === "GET") {
      const folderId = url.searchParams.get("folderId");
      if (options.postitCards) return fulfillJson(route, {cards:options.postitCards.filter(card=>!folderId||card.folderId===folderId)});
      return fulfillJson(route, { cards: options.unifiedFolderView && folderId === "folder-amber" ? [{
        id: "p1-card-folder-display",
        folderId: "folder-amber",
        title: "P1 카드 표시",
        request: "",
        brief: "",
        status: "running",
        blockedKind: null,
        blockedDetail: null,
        positionKey: "a",
        queuePositionKey: null,
        assigneeKind: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        assigneeSessionId: null,
        nodeId: null,
        modelPreset: null,
        version: 1,
        archived: false,
        createdAt: NOW,
        updatedAt: NOW,
      }] : [] });
    }
    if (path === "/api/config/settings" && request.method() === "GET") {
      return fulfillJson(route, { categories: [] });
    }
    if (path === "/api/folders" && request.method() === "GET") return fulfillJson(route, {
      folders: unifiedFolders.filter((folder) => !folder.archived), sessions: {},
    });
    if (path === "/api/folders" && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const created = fixtureFolder("rb-cj-created", page("task-cj-created", String(payload.name ?? "새 폴더")),
        typeof payload.parentFolderId === "string" ? payload.parentFolderId : null);
      unifiedFolders.push(created);
      return fulfillJson(route, { folder: created, created: true });
    }
    const archiveFolderMatch = /^\/api\/folders\/([^/]+)\/archive$/.exec(path);
    if (archiveFolderMatch && request.method() === "POST") {
      const folder = unifiedFolders.find((candidate) => candidate.id === decodeURIComponent(archiveFolderMatch[1]));
      if (!folder) return fulfillJson(route, { detail: "folder not found" }, 404);
      folder.archived = true;
      folder.version += 1;
      return fulfillJson(route, { folder, idempotent: false });
    }
    {
      const unifiedFolderMatch = /^\/api\/folders\/([^/]+)$/.exec(path);
      if (unifiedFolderMatch && request.method() === "GET") {
        const folder = unifiedFolders.find((candidate) => candidate.id === decodeURIComponent(unifiedFolderMatch[1]));
        if (!folder) return fulfillJson(route, { detail: "folder not found" }, 404);
        const snapshot = tasks[folder.id] as ReturnType<typeof task> | undefined;
        return fulfillJson(route, { folder, sections: snapshot ? [{ ...unifiedSection, folderId: folder.id }] : [unifiedSection],
          items: snapshot ? snapshot.items.map((item) => ({ ...unifiedItem, id: item.id,
            sectionId: "section-amber", title: item.title, status: item.status })) : [unifiedItem] });
      }
      const unifiedChildrenMatch = /^\/api\/folders\/([^/]+)\/children$/.exec(path);
      if (unifiedChildrenMatch && request.method() === "GET") {
        return fulfillJson(route, { items: unifiedFolders.filter((folder) =>
          folder.parentFolderId === decodeURIComponent(unifiedChildrenMatch[1])), nextCursor: null });
      }
      if (path === "/api/planner/today" && request.method() === "GET") {
        const daily = url.searchParams.get("date") === "2026-07-13" ? pageReads[pages.yesterday.id] : pageReads[pages.today.id];
        const todayIds = url.searchParams.get("date") === "2026-07-13" ? ["rb-carry"] : ["rb-alpha", "rb-beta"];
        const cards=options.postitCards??[];
        return fulfillJson(route, { attention: cards.filter(card=>card.status==="review"||card.status==="blocked"), running: cards.filter(card=>card.status==="running"), queued: cards.filter(card=>card.status==="queued"), daily, folders: todayIds.map((id) => {
          const folder = unifiedFolders.find((candidate) => candidate.id === id)!;
          return plannerFolderPayload(folder, folderPageById.get(id)!);
        }), memoBlocks: daily.blocks.filter((item) => !item.text.startsWith("[[")),
        reviewSessionIds: qaSessions.filter((session) => session.reviewState === "needs_review")
          .map((session) => session.agentSessionId) });
      }
      if (path === "/api/planner/starred-folders" && request.method() === "GET") {
        const alpha = unifiedFolders.find((candidate) => candidate.id === "rb-alpha")!;
        return fulfillJson(route, { items: pages.taskAlpha.metadata.starred
          ? [plannerFolderPayload(alpha, pages.taskAlpha)] : [], nextCursor: null });
      }
      const unifiedPlannerMatch = /^\/api\/planner\/folders\/([^/]+)(?:\/(subfolders|sessions))?$/.exec(path);
      if (unifiedPlannerMatch && request.method() === "GET") {
        const folderId = decodeURIComponent(unifiedPlannerMatch[1]);
        const folder = unifiedFolders.find((candidate) => candidate.id === folderId);
        if (!folder) return fulfillJson(route, { detail: "folder not found" }, 404);
        if (unifiedPlannerMatch[2] === "sessions") {
          runHistoryRequests += 1;
          options.onRunHistoryRequest?.(runHistoryRequests);
        } else {
          plannerProjectRequests += 1;
          options.onPlannerProjectRequest?.(plannerProjectRequests);
        }
        await delay(options.plannerDelayMs);
        const folderPage = folderPageById.get(folderId)!;
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const folderSessions = folderId === "folder-amber"
          ? qaSessions.filter((session) => session.agentSessionId.startsWith("folder-history-")
            || session.agentSessionId === outsideTaskSession.agentSessionId)
          : qaSessions.filter((session) => (runSessions[folderId] ?? []).includes(session.agentSessionId));
        const alphaPaged = options.alphaRunHistoryPages && folderId === "rb-alpha";
        const sessionPage = alphaPaged
          ? (url.searchParams.get("cursor") ? folderSessions.slice(0, 1) : folderSessions.slice(1, 2))
          : folderSessions.slice(offset, offset + 20);
        const sessionSlice = { items: sessionPage.map((session) => ({ ...session, eventCount: 0 })),
          nextCursor: alphaPaged
            ? (url.searchParams.get("cursor") ? null : "alpha-older")
            : offset + 20 < folderSessions.length ? String(offset + 20) : null };
        const subfolders = { items: unifiedFolders.filter((candidate) => candidate.parentFolderId === folderId), nextCursor: null };
        if (unifiedPlannerMatch[2] === "subfolders") return fulfillJson(route, subfolders);
        if (unifiedPlannerMatch[2] === "sessions") return fulfillJson(route, sessionSlice);
        const snapshot = tasks[folderId] as ReturnType<typeof task> | undefined;
        return fulfillJson(route, { cards: options.postitCards?.filter(card=>card.folderId===folderId)??[], folder, page: folderPage,
          blocks: pageReads[folderPage.id]?.blocks ?? [],
          sections: snapshot ? [{ ...unifiedSection, folderId }] : [unifiedSection],
          items: snapshot ? snapshot.items.map((item) => ({ ...unifiedItem, id: item.id,
            sectionId: "section-amber", title: item.title, status: item.status })) : [unifiedItem],
          subfolders, sessions: sessionSlice });
      }
    }
    const qaNodes = [{
        nodeId: "eiaserinnys",
        host: "localhost",
        port: 3105,
        status: "connected",
        capabilities: {},
        connectedAt: Date.parse(YESTERDAY),
        sessionCount: qaSessions.length,
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
        ? qaSessions.filter(
            (session) => !options.excludeSessionIdsFromInitialStream?.includes(session.agentSessionId),
          )
        : qaSessions;
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
          options.timelineContentByEventId,
        ),
      );
    }
    if (path === "/api/sessions" && request.method() === "GET") {
      options.onSessionListRequest?.();
      const requestedIds = url.searchParams.getAll("session_id");
      if (requestedIds.length === 0) await delay(options.catalogDelayMs);
      const selectedSessions = requestedIds.length > 0
        ? qaSessions.filter((session) => requestedIds.includes(session.agentSessionId))
        : qaSessions;
      return fulfillJson(route, { sessions: selectedSessions, total: selectedSessions.length });
    }
    if (path === "/api/sessions" && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      options.onSessionCreate?.(payload);
      const initialInstruction = typeof payload.initial_instruction === "string"
        ? payload.initial_instruction.trim()
        : "";
      const prompt = [
        "폴더 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.",
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
      const target = qaSessions.find((session) => session.agentSessionId === sessionId);
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
          default_preset: "qa-standard",
          portraitUrl: null,
        }] : [{
          id: "roselin_codex",
          name: "로젤린",
          backend: "codex",
          default_preset: "qa-standard",
          portraitUrl: "/api/nodes/eiaserinnys/agents/roselin_codex/portrait",
        }],
      });
    }
    if (/^\/api\/nodes\/[^/]+\/model-presets$/.test(path)) {
      return fulfillJson(route, {
        model_presets: [
          {
            id: "qa-standard",
            label: "QA 표준 모델",
            backend: "codex",
            available: true,
            reason: null,
            reason_label: null,
            resets_at: null,
            usage_warning: false,
          },
          {
            id: "qa-warning",
            label: "QA 사용량 확인 모델",
            backend: "codex",
            available: true,
            reason: null,
            reason_label: null,
            resets_at: null,
            usage_warning: true,
          },
          {
            id: "qa-limited",
            label: "QA 제한 모델",
            backend: "codex",
            available: false,
            reason: "quota_exhausted",
            reason_label: "주간 사용량 제한",
            resets_at: "2026-07-28T18:20:00+09:00",
            usage_warning: false,
          },
        ],
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
    if (path === "/api/planner/daily-history" && request.method() === "GET") {
      return fulfillJson(route, { dates: ["2026-07-13"] });
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
      if (!result) return fulfillJson(route, { detail: "page not found" }, 404);
      const response = pageId === pages.project.id && options.taskAssignmentModelPreset
        ? {
            ...result,
            blocks: result.blocks.map((candidate) => candidate.id === "project-defaults"
              ? {
                  ...candidate,
                  properties: {
                    ...candidate.properties,
                    modelPreset: options.taskAssignmentModelPreset,
                  },
                }
              : candidate),
          }
        : result;
      return fulfillJson(route, response);
    }
    const pageStarMatch = /^\/api\/pages\/([^/]+)\/starred$/.exec(path);
    if (pageStarMatch && request.method() === "PATCH") {
      const target = pageReads[decodeURIComponent(pageStarMatch[1])];
      if (!target) return fulfillJson(route, { detail: "page not found" }, 404);
      const payload = request.postDataJSON() as { starred: boolean };
      target.page.metadata.starred = payload.starred;
      target.page.version += 1;
      return fulfillJson(route, { page: target.page, blocks: target.blocks,
        operation: { id: `star-${target.page.id}-${target.page.version}` }, temp_id_mapping: {} });
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
        modelPreset: options.taskAssignmentModelPreset ?? null,
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
    const folderStatusMatch = /^\/api\/folders\/([^/]+)\/status$/.exec(path);
    if (folderStatusMatch && request.method() === "POST") {
      const folder = unifiedFolders.find((candidate) => candidate.id === decodeURIComponent(folderStatusMatch[1]));
      if (!folder) return fulfillJson(route, { detail: "folder not found" }, 404);
      const payload = request.postDataJSON() as { status?: "open" | "completed" };
      folder.status = payload.status ?? folder.status;
      folder.version += 1;
      return fulfillJson(route, { ok: true, snapshot: { folder, sections: [], items: [] } });
    }
    if (path === "/api/board-items") {
      await delay(options.plannerDelayMs);
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const owningFolderId = sessionId === "run-outside-task" ? "rb-done" : null;
        return fulfillJson(route, {
          boardItems: owningFolderId
            ? [boardItem("session", sessionId, owningFolderId, 0)]
            : [],
        });
      }
      const folderId = url.searchParams.get("folderId") ?? "";
      if (folderId === "folder-amber") {
        return fulfillJson(route, {
          boardItems: [
            ...runSessions["rb-alpha"].map((itemId, index) => boardItem("session", itemId, folderId, index * 72)),
            ...runSessions["rb-beta"].map((itemId, index) => boardItem("session", itemId, folderId, index * 72)),
          ],
        });
      }
      const inlineItems = folderId === inlineMarkdownTaskId ? [
        boardItem("markdown", "doc-inline", folderId, 160, {
          title: inlineMarkdownDocument.title,
          version: inlineMarkdownDocument.version,
        }),
        boardItem("custom_view", "view-inline", folderId, 240, { title: "검증 현황" }),
        boardItem("asset", "asset-inline", folderId, 320, { originalName: "context-menu-map.png", sourceUrl: "/context-menu-map.png" }),
      ] : [];
      return fulfillJson(route, {
        boardItems: [
          ...(runSessions[folderId] ?? []).map((itemId, index) => boardItem("session", itemId, folderId, index * 72)),
          ...inlineItems,
        ],
      });
    }
    const boardMoveMatch = /^\/api\/board-items\/([^/]+)\/folder$/.exec(path);
    if (boardMoveMatch && request.method() === "PATCH") {
      const boardItemId = decodeURIComponent(boardMoveMatch[1]);
      const body = request.postDataJSON() as { folderId?: string };
      const targetTaskId = body.folderId ?? null;
      if (!targetTaskId || !runSessions[targetTaskId]) return fulfillJson(route, { detail: "target not found" }, 404);
      if (boardItemId === "markdown:doc-inline") {
        inlineMarkdownTaskId = targetTaskId;
        return fulfillJson(route, {
          ok: true,
          boardItem: boardItem("markdown", "doc-inline", targetTaskId, 160, {
            title: inlineMarkdownDocument.title,
            version: inlineMarkdownDocument.version,
          }),
        });
      }
      const sessionId = boardItemId.startsWith("session:") ? boardItemId.slice("session:".length) : boardItemId;
      for (const ids of Object.values(runSessions)) {
        const index = ids.indexOf(sessionId);
        if (index >= 0) ids.splice(index, 1);
      }
      runSessions[targetTaskId].push(sessionId);
      return fulfillJson(route, { ok: true, boardItem: boardItem("session", sessionId, targetTaskId, 0) });
    }
    if (path === "/api/markdown-documents/doc-inline") {
      if (request.method() === "DELETE") {
        inlineMarkdownTaskId = null;
        return fulfillJson(route, { ok: true });
      }
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

    if (options.abortUnknownApiRoutes) {
      options.onUnknownApiRequest?.(request.method(), path);
      return route.abort();
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
};

/** The connection harness serves this snapshot over the real SSE route. */
export const connectionQaSessions = sessions;
