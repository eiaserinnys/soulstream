import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";
import type { CardCheckItem, CardComment, CardDetail, CardNow, CardNowHistoryEntry, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
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
  attachments: [],
  request: "샘플을 눌러 보고 입력창에 한 줄과 여러 줄을 작성합니다.", brief: "",
  status: "running", blockedKind: null, blockedDetail: null,
  positionKey: "a", queuePositionKey: null, assigneeKind: "session",
  assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: reviewSession.agentSessionId,
  nodeId: "eiaserinnys", modelPreset: "Sol", version: 1, archived: false,
  createdAt: now, updatedAt: now,
};

export const reviewCardItems: CardCheckItem[] = [
  { id: 1, title: "요청된 화면 상태가 실제 응답대로 보입니다", state: "todo", result: null, evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: null, display: "todo" },
  { id: 2, title: "세션 카드와 같은 실행 띠가 보입니다", state: "doing", result: "작업 화면에서 실행 중인 항목입니다.", evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: null, display: "doing" },
  { id: 3, title: "보고한 결과가 파란 바탕으로 보입니다", state: "done", result: "완료 결과를 확인할 수 있습니다.", evidence: [{ type: "image", url: "/icon-192.png", label: "완료 화면" }], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: { commentId: "sample-comment", kind: "comment", at: now }, createdAt: now, reportedAt: now, display: "reported" },
  { id: 4, title: "다시 확인할 항목이 표시됩니다", state: "doing", result: "최신 설명을 읽어 주세요.", evidence: [{ type: "link", url: "/components", label: "설계 설명" }], caveat: null, rev: 2, confirmed: null, fixOpen: 0, reopened: "변경된 화면을 한 번 더 확인해 주세요.", from: null, createdAt: now, reportedAt: now, display: "changed" },
  { id: 5, title: "남겨진 고칠 점이 표시됩니다", state: "doing", result: "대상 댓글이 연결된 항목입니다.", evidence: [], caveat: "입력 폭이 좁은 화면을 확인해 주세요.", rev: 2, confirmed: null, fixOpen: 2, reopened: null, from: null, createdAt: now, reportedAt: now, display: "fix" },
  { id: 6, title: "이미 확인한 항목 하나", state: "done", result: "사용자가 이미 확인했습니다.", evidence: [], caveat: null, rev: 1, confirmed: { at: now, rev: 1 }, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: now, display: "confirmed" },
  { id: 7, title: "요청에서 뺀 항목", state: "dropped", result: "현재 범위에 포함되지 않습니다.", evidence: [{ type: "image", url: "/icon-512.png", label: "제외 근거" }], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: now, display: "dropped" },
  { id: 8, title: "목록 점에는 잘리지 않고 포함됩니다", state: "todo", result: null, evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: null, display: "todo" },
  { id: 9, title: "긴 설명도 자연스럽게 줄바꿈하며 읽을 수 있습니다", state: "todo", result: "화면이 좁아도 전송 버튼과 다른 글을 밀지 않도록 내용을 나누어 확인합니다.", evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: null, display: "todo" },
  { id: 10, title: "처음 확인한 항목 둘", state: "done", result: "확인함 묶음 안에 표시합니다.", evidence: [], caveat: null, rev: 1, confirmed: { at: now, rev: 1 }, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: now, display: "confirmed" },
  { id: 11, title: "처음 확인한 항목 셋", state: "done", result: "확인함 묶음에 세 항목이 모입니다.", evidence: [], caveat: null, rev: 1, confirmed: { at: now, rev: 1 }, fixOpen: 0, reopened: null, from: null, createdAt: now, reportedAt: now, display: "confirmed" },
];

export const reviewNow: CardNow = {
  text: "요청된 카드 화면을 확인하고 있습니다.", turn: "user", ask: "보고된 결과 두 개를 확인해 주세요.",
  updatedAt: "2026-10-05T08:00:00Z", sessionId: reviewSession.agentSessionId,
};

export const reviewNowHistory: CardNowHistoryEntry[] = [
  { text: "초기 확인 항목을 정리하고 있습니다.", turn: "agent", ask: "결과를 작성하고 있습니다.", at: "2026-10-05T06:30:00Z" },
  { text: "사용자가 마지막으로 요청한 것을 확인하고 있습니다.", turn: "user", ask: "확인이 끝나면 완료를 알려 주세요.", at: "2026-10-05T07:00:00Z" },
  { text: "상황판 이력의 마지막 저장 글입니다.", turn: "outside", ask: null, at: "2026-10-05T07:30:00Z" },
  { text: reviewNow.text, turn: reviewNow.turn, ask: reviewNow.ask, at: reviewNow.updatedAt },
];

export const reviewNotes: CardComment[] = Array.from({ length: 6 }, (_, index) => ({
  id: `sample-note-${index + 1}`, cardId: reviewCard.id, authorKind: index % 2 ? "user" : "agent",
  authorId: index % 2 ? "sample-user" : "roselin", sessionId: index % 2 ? null : reviewSession.agentSessionId,
  kind: "note", body: `노트 ${index + 1} · 인계에 필요한 결정과 진행 내용을 기록합니다.`,
  createdAt: `2026-10-05T0${index + 1}:00:00Z`,
}));

export const reviewDetail: CardDetail = {
  card: reviewCard, sessions: [], questions: [], comments: [],
  notes: [], nowHistory: [],
  reports: [{ id: "components-report", title: "말풍선과 첨부 검수", format: "markdown", sessionId: null, createdAt: now,
    body: "긴 한국어 본문이 자연스럽게 줄바꿈되는지 확인합니다.\n\n![검수 이미지](/icon-192.png)\n\n[샘플 첨부 열기](/icon-512.png)" }],
};

export const reviewFolders: CatalogFolder[] = [
  { id: "components-folder", name: "검수 폴더", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "components-emoji", name: "👩‍💻 검수 폴더", parentFolderId: null, sortOrder: 2, status: "open", version: 1, archived: false },
  { id: "components-child", name: reviewTitle, parentFolderId: "components-folder", sortOrder: 1, status: "open", version: 1, archived: false },
];

export function reviewFolder(title: string, id: string): PlannerFolder {
  return {
    page: { id, title, daily_date: null, version: 1, metadata: {}, archived: false, created_at: now, updated_at: now },
    blocks: [], stateVector: "", folderId: id, status: "in_progress", assignee: "로젤린",
    contextCount: 0, progress: null, parentFolderId: null, sessionIds: [reviewSession.agentSessionId],
  };
}
