import type { Page, Route } from "@playwright/test";

const NOW = "2026-07-14T01:30:00.000Z";
const YESTERDAY = "2026-07-13T08:20:00.000Z";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
let blockSequence = 0;

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
  project: page("project-amber", "Amber & Blade", null, { folderId: "folder-amber" }),
  projectOps: page("project-ops", "Soulstream 운영", null, { folderId: "folder-ops" }),
  today: page("daily-2026-07-14", "2026-07-14", "2026-07-14"),
  yesterday: page("daily-2026-07-13", "2026-07-13", "2026-07-13"),
  taskAlpha: page("task-alpha", "업무 카드 밀도와 계층 최종 QA"),
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
      block("today-memo", pages.today.id, "paragraph", "아침 배포 전 시각 QA 결과를 한 번 더 확인한다."),
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
      block("project-guidance", pages.project.id, "guidance", "리테이크가 필요 없는 완성도를 우선한다.", { enabled: true, scope: "session" }),
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
  [pages.taskAlpha.id]: {
    page: pages.taskAlpha,
    state_vector: "AA==",
    blocks: [
      block("alpha-description", pages.taskAlpha.id, "paragraph", "## 목표\n\n목업 v4.5의 밀도와 계층을 유지하면서 다크·라이트 양쪽을 마감한다."),
      block("alpha-check", pages.taskAlpha.id, "checklist", "가로 오버플로 0", { checked: false }),
      block("alpha-runbook", pages.taskAlpha.id, "runbook_ref", "", { runbookId: "rb-alpha", primary: true }),
      block("alpha-atom", pages.taskAlpha.id, "atom_ref", "", { instance: "atom", nodeId: "planner-design", title: "플래너 UX 원칙" }),
      block("alpha-guidance", pages.taskAlpha.id, "guidance", "대비와 잘림을 실제 픽셀로 확인", { enabled: true, scope: "session" }),
      block("alpha-defaults", pages.taskAlpha.id, "session_defaults", "", { agentId: "roselin_codex", nodeId: "eiaserinnys", scope: "session" }),
      block("alpha-doc", pages.taskAlpha.id, "paragraph", `[[${pages.document.title}]]`),
    ],
  },
  [pages.taskBeta.id]: {
    page: pages.taskBeta,
    state_vector: "AA==",
    blocks: [
      block("beta-description", pages.taskBeta.id, "paragraph", "390px에서 오늘·업무·채팅의 선택 상태를 유지한다."),
      block("beta-runbook", pages.taskBeta.id, "runbook_ref", "", { runbookId: "rb-beta", primary: true }),
      block("beta-guidance", pages.taskBeta.id, "guidance", "손가락으로 누르기 쉬운 탭 크기", { enabled: true, scope: "session" }),
    ],
  },
  [pages.taskDone.id]: {
    page: pages.taskDone,
    state_vector: "AA==",
    blocks: [
      block("done-description", pages.taskDone.id, "paragraph", "키보드 포커스와 라벨을 정리했다."),
      block("done-runbook", pages.taskDone.id, "runbook_ref", "", { runbookId: "rb-done", primary: true }),
    ],
  },
  [pages.carryover.id]: {
    page: pages.carryover,
    state_vector: "AA==",
    blocks: [
      block("carry-description", pages.carryover.id, "paragraph", "리추얼 모달의 카드·버튼 간격을 마지막으로 확인한다."),
      block("carry-runbook", pages.carryover.id, "runbook_ref", "", { runbookId: "rb-carry", primary: true }),
    ],
  },
  [pages.document.id]: { page: pages.document, state_vector: "AA==", blocks: [] },
  [pages.documentTwo.id]: { page: pages.documentTwo, state_vector: "AA==", blocks: [] },
};

const allPages = Object.values(pages);

function runbook(id: string, title: string, statuses: string[], status = "open") {
  return {
    runbook: {
      id,
      board_item_id: `runbook:${id}`,
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

const runbooks: Record<string, Json> = {
  "rb-alpha": runbook("rb-alpha", pages.taskAlpha.title, ["completed", "in_progress", "pending"]),
  "rb-beta": runbook("rb-beta", pages.taskBeta.title, ["completed", "review", "pending"]),
  "rb-done": runbook("rb-done", pages.taskDone.title, ["completed", "completed"], "completed"),
  "rb-carry": runbook("rb-carry", pages.carryover.title, ["in_progress", "pending"]),
};

const sessions = [
  {
    agentSessionId: "run-alpha-1",
    status: "completed",
    reviewState: "acknowledged",
    sessionType: "claude",
    createdAt: "2026-07-13T09:00:00.000Z",
    updatedAt: "2026-07-13T11:20:00.000Z",
    completedAt: "2026-07-13T11:20:00.000Z",
    displayName: "밀도 기준 정리",
    awaySummary: "카드 계층과 간격 토큰을 목업에 맞춰 정리했습니다.",
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-alpha-2",
    status: "running",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-14T00:30:00.000Z",
    updatedAt: NOW,
    displayName: "시각 QA 순회",
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-alpha-child",
    status: "completed",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-14T00:50:00.000Z",
    updatedAt: "2026-07-14T01:10:00.000Z",
    displayName: "대비 확인",
    awaySummary: "라이트 모드의 입력 영역 대비를 점검했습니다.",
    callerSessionId: "run-alpha-2",
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
  {
    agentSessionId: "run-beta-1",
    status: "completed",
    reviewState: "not_required",
    sessionType: "claude",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T13:15:00.000Z",
    displayName: "모바일 탭 구현",
    awaySummary: "모바일 세 탭의 선택 상태 유지 로직을 구현했습니다.",
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
    displayName: "PR-G /v2 셸 파기 검수",
    awaySummary: "리다이렉트와 v1 diff 0을 확인했습니다.",
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  },
];

const runSessions: Record<string, string[]> = {
  "rb-alpha": ["run-alpha-1", "run-alpha-2"],
  "rb-beta": ["run-beta-1"],
  "rb-done": [],
  "rb-carry": [],
};

async function fulfillJson(route: Route, body: Json, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installV3VisualQaRoutes(pageInstance: Page): Promise<void> {
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
    if (path === "/api/folders") return fulfillJson(route, {
      folders: [
        { id: "folder-amber", name: pages.project.title, parent_id: null },
        { id: "folder-ops", name: pages.projectOps.title, parent_id: null },
      ],
      sessions: {},
    });
    if (path === "/api/nodes") return fulfillJson(route, {
      nodes: [{
        nodeId: "eiaserinnys",
        host: "localhost",
        port: 3105,
        status: "connected",
        capabilities: {},
        connectedAt: Date.parse(YESTERDAY),
        sessionCount: sessions.length,
      }],
    });
    if (path === "/api/nodes/stream" || path === "/api/sessions/stream") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": visual-qa\n\n" });
    }
    if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": empty session\n\n" });
    }
    if (path === "/api/sessions" && request.method() === "GET") {
      return fulfillJson(route, { sessions, total: sessions.length });
    }
    if (path === "/api/sessions/folder-counts") return fulfillJson(route, { counts: {} });
    if (/^\/api\/nodes\/[^/]+\/agents$/.test(path)) return fulfillJson(route, {
      agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex", portraitUrl: null }],
    });
    if (path === "/api/pages/daily" && request.method() === "POST") {
      const body = request.postDataJSON() as { date?: string };
      const selected = body.date === "2026-07-13" ? pages.yesterday : pages.today;
      return fulfillJson(route, { page: selected, created: false });
    }
    if (path === "/api/pages" && request.method() === "GET") {
      const items = url.searchParams.get("starred") === "true"
        ? [pages.project, pages.projectOps]
        : allPages;
      return fulfillJson(route, { items, next_cursor: null });
    }
    if (path === "/api/pages/search") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      return fulfillJson(route, {
        items: allPages
          .filter((item) => item.title.toLowerCase().includes(query))
          .map((item) => ({ pageId: item.id, title: item.title })),
      });
    }
    const pageMatch = /^\/api\/pages\/([^/]+)$/.exec(path);
    if (pageMatch && request.method() === "GET") {
      const result = pageReads[decodeURIComponent(pageMatch[1])];
      return result ? fulfillJson(route, result) : fulfillJson(route, { detail: "page not found" }, 404);
    }
    if (/^\/api\/pages\/[^/]+\/backlinks$/.test(path)) {
      const taskId = decodeURIComponent(path.split("/")[3] ?? "");
      const sourcePageId = [pages.taskAlpha.id, pages.taskBeta.id, pages.taskDone.id, pages.carryover.id].includes(taskId)
        ? pages.project.id
        : null;
      return fulfillJson(route, {
        items: sourcePageId ? [{
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
        }] : [],
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
    const runbookMatch = /^\/api\/runbooks\/([^/]+)$/.exec(path);
    if (runbookMatch) {
      const snapshot = runbooks[decodeURIComponent(runbookMatch[1])];
      return snapshot ? fulfillJson(route, snapshot) : fulfillJson(route, { detail: "runbook not found" }, 404);
    }
    if (path === "/api/board-items") {
      const runbookId = url.searchParams.get("container_id") ?? "";
      return fulfillJson(route, {
        boardItems: (runSessions[runbookId] ?? []).map((itemId) => ({ itemType: "session", itemId })),
      });
    }

    return fulfillJson(route, { ok: true });
  });
}

export const fixtureTitles = {
  primaryTask: pages.taskAlpha.title,
  project: pages.project.title,
};
