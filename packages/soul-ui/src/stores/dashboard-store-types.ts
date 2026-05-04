/**
 * Soul Dashboard Store - 타입 정의
 *
 * DashboardState, DashboardActions와 관련 export 타입.
 * dashboard-store.ts가 re-export하므로 외부 consumer는 여전히
 * `import { ... } from "stores/dashboard-store"` 형태로 사용한다.
 */

import type { QueryClient } from "@tanstack/react-query";
import type {
  SessionSummary,
  SessionDetail,
  SessionStatus,
  SoulSSEEvent,
  EventTreeNode,
  CatalogState,
  CatalogFolder,
} from "@shared/types";
import type { ProcessingContext, TreeChangeInfo } from "./processing-context";

// === Dashboard Config ===

export interface ProfileConfig {
  name: string;
  id: string;
  hasPortrait: boolean;
  portraitUrl?: string | null;
}

export interface DashboardAgentConfig {
  id: string;
  name: string;
  hasPortrait: boolean;
  portraitUrl: string | null;
}

export interface DashboardConfig {
  user: ProfileConfig;
  agents: DashboardAgentConfig[];
}

// === Selected Event Node Data ===

/** selectEventNode로 선택된 이벤트 노드의 데이터 (user, intervention, system, result) */
export interface SelectedEventNodeData {
  nodeType: "user" | "intervention" | "system" | "result";
  label: string;
  content: string;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  isError?: boolean;
}

// === Folder Sort Mode ===

export type FolderSortMode =
  | "name-asc"
  | "name-desc"
  | "created-desc"
  | "created-asc"
  | "custom";

// === Mobile Tab ===

export type MobileTab = "feed" | "folder" | "chat" | "settings";

// === ProcessEventsResult ===

/** processEvents 반환 타입: SSE 이벤트 배치 처리 결과 */
export interface ProcessEventsResult {
  statusUpdates: Array<{ agentSessionId: string; status: SessionStatus }>;
}

// === State Interface ===

export interface DashboardState {
  /** 뷰 모드 — URL 해시에서 파생. 'feed' = 피드 뷰, 'folder' = 기존 폴더 뷰 */
  viewMode: "feed" | "folder";

  /** 피드 스크롤 오프셋 (뷰 전환 시 위치 복원용) */
  feedScrollOffset: number;

  /** 세션 타입 필터 */
  sessionTypeFilter: "all" | "claude" | "llm";

  /** 활성 세션 (현재 보고 있는 세션) */
  activeSessionKey: string | null;
  activeSession: SessionDetail | null;

  /** 활성 세션의 SessionSummary 스냅샷 — sessions.find 대체용 (단일 구독 포인트) */
  activeSessionSummary: SessionSummary | null;

  /** 선택된 카드 (상세 뷰에 표시) */
  selectedCardId: string | null;

  /** 선택된 React Flow 노드 ID */
  selectedNodeId: string | null;

  /** 선택된 이벤트 노드 데이터 (user/intervention/system/result 노드용) */
  selectedEventNodeData: SelectedEventNodeData | null;

  /** 이벤트 트리 루트 (소스 오브 트루스) */
  tree: EventTreeNode | null;

  /** 트리 변경 감지용 카운터 (mutable tree이므로 참조 비교 불가) */
  treeVersion: number;

  /**
   * 채팅창 좌표 정본 — Virtuoso firstItemIndex = START_INDEX - chatPrependedCount.
   *
   * processHistoryEvents가 grouped 차분(messages 차분이 아니라)을 누적한다.
   * grouped 단위로 갱신해야 firstItemIndex 변화량과 Virtuoso data(grouped) 추가량이
   * 정합되어 화면 위치 보존이 정확해진다 (좌표 단위 통일).
   *
   * tree 갱신과 같은 set() 안에서 atomic 갱신 → Zustand subscribe 1회 → 1렌더 사이클 정합.
   * 세션 전환 시 0으로 리셋된다 (getSessionResetState).
   */
  chatPrependedCount: number;

  /**
   * 마지막 prepend 시각 (performance.now() 기반). atBottom=true settle 가드용.
   *
   * react-virtuoso는 prepend로 firstItemIndex가 바뀐 직후 한 프레임 동안
   * atBottom 판정이 흔들릴 수 있다 — 그 시점의 잘못된 atBottom=true 보고를
   * 무시하기 위해 가장 최근 prepend 시각을 추적한다 (ChatView.follow-helpers
   * decideFollowOnAtBottomChange의 prependAgeMs 인자).
   *
   * null = 직전 prepend 없음 (또는 세션 진입 후 첫 prepend 전).
   * processHistoryEvents의 set() 안에서 chatPrependedCount와 함께 atomic
   * 갱신되며, 세션 리셋 시 null로 돌아간다.
   */
  chatLastPrependAtMs: number | null;

  /** 마지막 트리 변경의 유형 — NodeGraph가 증분 업데이트 vs 전체 재빌드를 분기하는 기준 */
  treeChangeInfo: TreeChangeInfo | null;

  /** 마지막으로 수신한 이벤트 ID (SSE 재연결용) */
  lastEventId: number;

  /**
   * 현재 활성 세션 트리의 총 서브트리 높이 (Phase 3 viewport API).
   * subtree_update SSE 이벤트로 증분 갱신되며, 뷰포트 가상화 컨테이너 크기 계산에 사용된다.
   * 세션 전환 시 0으로 초기화되고, 이후 events_viewport 응답의 new_total_subtree_height로 재동기화된다.
   */
  totalSubtreeHeight: number;

  /** 알림 대상 이벤트 큐 (complete, error, intervention_sent) */
  pendingNotifications: SoulSSEEvent[];

  /** New Session 모달 열림 상태 */
  isNewSessionModalOpen: boolean;

  /** New Session 모달을 연 진입 경로 ('folder': 폴더 뷰, 'feed': 피드 뷰) */
  newSessionSource: "folder" | "feed";

  /** 접힌 노드 ID 집합 (접기/펼치기 기능) */
  collapsedNodeIds: Set<string>;

  /** 오른쪽 패널 활성 탭 */
  activeRightTab: "detail" | "chat" | "info";

  /** 대시보드 프로필 설정 */
  dashboardConfig: DashboardConfig | null;

  /** 이벤트 처리 컨텍스트 (nodeMap, activeTextTarget 등) */
  processingCtx: ProcessingContext;

  /** 입력창 임시 저장 (키: 세션ID / '__draft__{folderId}')
   * ⚠️ getSessionResetState()에 포함하지 않는 것이 이 기능의 핵심 — drafts는 세션 전환 시 초기화하지 않는다 */
  drafts: Record<string, string>;

  /** 검색 결과 클릭 시 스크롤할 이벤트 ID (ChatView가 감지하여 해당 메시지로 스크롤) */
  focusEventId: number | null;

  /** 세션 다중 선택 ID 집합 */
  selectedSessionIds: Set<string>;

  /** Shift+클릭 범위 기준점 */
  lastSelectedSessionId: string | null;

  /** 인라인 편집 중인 세션 */
  editingSessionId: string | null;

  /** 모바일 활성 탭 */
  activeTab: MobileTab;

  /** 폴더 카탈로그 상태 */
  catalog: CatalogState | null;

  /** 선택된 폴더 ID (null = 미분류) */
  selectedFolderId: string | null;

  /** 카탈로그 변경 감지용 카운터 */
  catalogVersion: number;

  /** 폴더 목록 정렬 모드 (localStorage에 저장) */
  folderSortMode: FolderSortMode;
}

// === Actions Interface ===

export interface DashboardActions {
  // 세션 타입 필터
  setSessionTypeFilter: (type: "all" | "claude" | "llm") => void;

  // 활성 세션
  setActiveSession: (key: string | null, detail?: SessionDetail) => void;
  setActiveSessionSummary: (summary: SessionSummary | null) => void;

  // 카드 선택 (nodeId: React Flow 노드의 고유 ID, switchTab: detail 탭 전환 여부)
  selectCard: (cardId: string | null, nodeId?: string | null, switchTab?: boolean) => void;

  // 이벤트 노드 선택 (user/intervention/system/result 등 카드가 아닌 노드)
  selectEventNode: (
    data: SelectedEventNodeData | null,
    nodeId?: string | null,
    switchTab?: boolean,
  ) => void;

  // SSE 이벤트 처리
  processEvent: (
    event: SoulSSEEvent,
    eventId: number,
  ) => { agentSessionId: string; status: SessionStatus } | null;

  /**
   * 뷰포트 API 응답의 total_subtree_height로 totalSubtreeHeight 상태를 덮어쓴다.
   * subtree_update SSE delta는 증분 갱신이지만 이 setter는 서버가 알려준 정본을 반영한다.
   * 초기 로드 / 세션 전환 / 드리프트 교정에 사용한다.
   */
  setTotalSubtreeHeight: (total: number) => void;

  // SSE 이벤트 배치 처리 (히스토리 리플레이 최적화: N개 이벤트를 트리에 적용 후 set() 1회)
  processEvents: (
    events: Array<{ event: SoulSSEEvent; eventId: number }>,
  ) => ProcessEventsResult;

  /**
   * 히스토리 prepend 처리 — messages API에서 받은 raw 이벤트들을 store.tree에 통합한다.
   *
   * processingCtx.historyMode를 잠시 true로 toggle하여 부모 부재 자식을
   * orphan 큐로 분기시킨다(tree-placer.ts:resolveParent). 라이브 SSE의
   * root fallback 동작은 보존된다.
   *
   * 반환 addedCount는 grouped(MessageOrGroup) 차분이며, 같은 set() 안에서
   * store.chatPrependedCount += addedCount 로 atomic 갱신된다.
   * (Virtuoso firstItemIndex 변화량 = data 추가량 정합 보장 — 좌표 단위 통일)
   */
  processHistoryEvents: (
    events: Array<{ event: SoulSSEEvent; eventId: number }>,
  ) => { addedCount: number };

  // 낙관적 세션 추가 + 활성 세션 설정 (세션 생성 직후 즉시 목록 반영)
  addOptimisticSession: (
    queryClient: QueryClient,
    agentSessionId: string,
    prompt: string,
    folderId?: string | null,
    nodeId?: string,
    agentId?: string | null,
    agentName?: string | null,
    agentPortraitUrl?: string | null,
  ) => void;

  // New Session 모달
  openNewSessionModal: (source?: "folder" | "feed") => void;
  closeNewSessionModal: () => void;

  // 상태 초기화
  clearTree: () => void;
  reset: () => void;

  // 접기/펼치기
  toggleNodeCollapse: (nodeId: string) => void;
  setNodeCollapsed: (nodeId: string, collapsed: boolean) => void;
  clearCollapsedNodes: () => void;

  // 오른쪽 패널 탭
  setActiveRightTab: (tab: "detail" | "chat" | "info") => void;

  // 대시보드 프로필 설정
  setDashboardConfig: (config: DashboardConfig) => void;

  // input_request 타임아웃 만료 처리
  expireInputRequest: (nodeId: string) => void;

  // draft 저장/삭제
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;

  // 검색 포커스 이벤트 ID
  setFocusEventId: (eventId: number | null) => void;

  // 뷰 모드 (URL 동기화 전용)
  setViewMode: (mode: "feed" | "folder") => void;
  selectFeed: () => void;
  setFeedScrollOffset: (offset: number) => void;

  // 카탈로그
  setCatalog: (catalog: CatalogState) => void;
  selectFolder: (folderId: string | null) => void;
  clearSelectedFolder: () => void;
  moveSessionsToFolder: (sessionIds: string[], folderId: string | null) => void;
  renameSession: (sessionId: string, displayName: string | null) => void;
  addFolder: (folder: CatalogFolder) => void;
  updateFolderName: (folderId: string, name: string) => void;
  updateFolderSettings: (
    folderId: string,
    settings: CatalogFolder["settings"],
  ) => void;
  removeFolder: (folderId: string) => void;
  /** 폴더 순서 낙관적 갱신: orderedFolderIds 순서대로 sortOrder를 재계산하여 store에 반영 */
  reorderFolders: (orderedFolderIds: string[]) => void;

  // 폴더 정렬 모드
  setFolderSortMode: (mode: FolderSortMode) => void;

  // 모바일 탭 전환
  setActiveTab: (tab: MobileTab) => void;

  // 활성 세션 해제 (selectedFolderId를 유지하면서 세션만 해제)
  clearActiveSession: () => void;

  // 다중 선택
  toggleSessionSelection: (
    id: string,
    ctrlKey: boolean,
    shiftKey: boolean,
    folderSessions?: SessionSummary[],
  ) => void;
  clearSelection: () => void;
  setEditingSession: (id: string | null) => void;
}
