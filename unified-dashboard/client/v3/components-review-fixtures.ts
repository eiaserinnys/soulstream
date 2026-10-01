import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";
import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { PlannerFolder } from "./planner-data";

export const reviewTitle = "목록의 안쪽 여백과 긴 한국어 제목, 오른쪽 아이콘과 버튼의 정렬을 함께 확인하는 검수 샘플입니다";
const now = "2026-10-01T00:00:00Z";

export const reviewSession: SessionSummary = {
  agentSessionId: "components-session", displayName: "세션 행 기본",
  status: "running", eventCount: 1, agentId: "roselin", agentName: "로젤린",
  nodeId: "eiaserinnys", modelLabel: "Sol", backend: "codex",
  agentPortraitUrl: "/system-portrait.png", createdAt: now, updatedAt: now,
  prompt: "같은 행에서 제목과 미리보기, 초상과 상태를 대조합니다.",
};

export const reviewCard: CardRow = {
  id: "components-card", folderId: "components-folder", title: "카드 행 기본",
  request: "샘플을 눌러 보고 입력창에 한 줄과 여러 줄을 작성합니다.", brief: "",
  status: "running", blockedKind: null, blockedDetail: null,
  positionKey: "a", queuePositionKey: null, assigneeKind: "session",
  assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: reviewSession.agentSessionId,
  nodeId: "eiaserinnys", modelPreset: "Sol", version: 1, archived: false,
  createdAt: now, updatedAt: now,
};

export const reviewDetail: CardDetail = {
  card: reviewCard, sessions: [], questions: [], comments: [],
  reports: [{ id: "components-report", title: "말풍선과 첨부 검수", format: "markdown", sessionId: null, createdAt: now,
    body: "긴 한국어 본문이 자연스럽게 줄바꿈되는지 확인합니다.\n\n![검수 이미지](/icon-192.png)\n\n[샘플 첨부 열기](/icon-512.png)" }],
};

export const reviewFolders: CatalogFolder[] = [
  { id: "components-folder", name: "검수 폴더", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "components-child", name: reviewTitle, parentFolderId: "components-folder", sortOrder: 1, status: "open", version: 1, archived: false },
];

export function reviewFolder(title: string, id: string): PlannerFolder {
  return {
    page: { id, title, daily_date: null, version: 1, metadata: {}, archived: false, created_at: now, updated_at: now },
    blocks: [], stateVector: "", folderId: id, status: "in_progress", assignee: "로젤린",
    contextCount: 0, progress: null, parentFolderId: null, sessionIds: [reviewSession.agentSessionId],
  };
}
