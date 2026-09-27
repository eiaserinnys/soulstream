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
  SoulSSEEvent,
  SessionNotice,
  EventTreeNode,
  CatalogState,
  CatalogFolder,
  CatalogBoardItem,
  BoardContainerRef,
  CatalogFolderReorderItem,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";
import type { ClaudeRuntimeView } from "./claude-runtime-state";
import type { WallpaperMode, WallpaperSettings } from "../lib/wallpaper-settings";
import type { LiquidGlassSettings } from "../lib/glass-settings";
import type { ChatFontSize } from "../lib/chat-typography";
import type { ChatFocusTarget } from "../shared/search-focus";

export interface NewSessionDefaults {
  folderId?: string | null;
  container?: BoardContainerRef | null;
  sourceTaskItemId?: string | null;
  nodeId?: string;
  agentId?: string | null;
  modelPreset?: string | null;
  boardPosition?: { x: number; y: number };
}

// === Folder Sort Mode ===

export type FolderSortMode =
  | "name-asc"
  | "name-desc"
  | "created-desc"
  | "created-asc"
  | "custom";

// === Mobile Tab ===

export type DashboardViewMode = "feed" | "folder" | "tasks";

export type MobileTab = "feed" | "folder" | "tasks" | "chat" | "settings";

export interface HistoryCursorSnapshot {
  sessionId: string;
  historyResetVersion: number;
  nextCursor: string | null;
  initialPageLoaded: boolean;
  reachedTop: boolean;
}

// === Desktop Left Navigation ===

export type LeftNavigationMode = "folders" | "feed";

export type { ChatFontSize, LiquidGlassSettings, WallpaperMode, WallpaperSettings };

// === State Interface ===

export interface DashboardState {
  /** 뷰 모드 — URL 해시에서 파생. tasks는 업무 모아보기 */
  viewMode: DashboardViewMode;

  /** 피드 스크롤 오프셋 (뷰 전환 시 위치 복원용) */
  feedScrollOffset: number;

  /** 활성 세션 (현재 보고 있는 세션) */
  activeSessionKey: string | null;
  activeSession: SessionDetail | null;

  /** 활성 세션의 SessionSummary 스냅샷 — sessions.find 대체용 (단일 구독 포인트) */
  activeSessionSummary: SessionSummary | null;

  /** 이벤트 트리 루트 (소스 오브 트루스) */
  tree: EventTreeNode | null;

  /** Claude Agent SDK runtime task 상태. P0-A claude_runtime_* wire에서 복원한다. */
  claudeRuntime: ClaudeRuntimeView | null;

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

  /** 마지막으로 수신한 이벤트 ID (SSE 재연결용) */
  lastEventId: number;

  /** Durable history invalidation generation for reset markers and cleared trees. */
  historyResetVersion: number;

  /** Current session's history cursor so a remounted chat view can continue pagination. */
  historyCursor: HistoryCursorSnapshot | null;

  /** 모든 세션의 정규화된 브라우저 알림 큐. */
  pendingNotifications: SessionNotice[];

  /** New Session 모달 열림 상태 */
  isNewSessionModalOpen: boolean;

  /** New Session 모달을 연 진입 경로 ('folder': 폴더 뷰, 'feed': 피드 뷰) */
  newSessionSource: "folder" | "feed";

  /** 특정 진입점에서 New Session 모달에 주입하는 초기 선택값 */
  newSessionDefaults: NewSessionDefaults | null;

  /** 오른쪽 패널 활성 탭 */
  activeRightTab: "detail" | "chat" | "info";

  /** 이벤트 처리 컨텍스트 (nodeMap, activeTextTarget 등) */
  processingCtx: ProcessingContext;

  /** 입력창 임시 저장 (키: 세션ID / '__draft__{folderId}')
   * ⚠️ getSessionResetState()에 포함하지 않는 것이 이 기능의 핵심 — drafts는 세션 전환 시 초기화하지 않는다 */
  drafts: Record<string, string>;

  /** 세션별 마지막 prompt_suggestion 텍스트. SDK가 turn당 1개 emit.
   * 정본은 서버 EventStore — partialize에 포함하지 않으며, 새로고침 시 history_sync baseline으로 복원된다.
   * drafts와 같은 정책: getSessionResetState()에 포함하지 않아 세션 전환 시 보존된다. */
  lastPromptSuggestions: Record<string, string | null>;

  /** 검색 결과 클릭 시 스크롤할 이벤트 ID (ChatView가 감지하여 해당 메시지로 스크롤) */
  focusEventId: number | null;

  /** Search-hit to transcript-row mapping selected by the search-event contract. */
  focusEventTarget: ChatFocusTarget | null;

  /** focusEventId의 소유 세션. 다른 세션의 같은 이벤트 번호에 포커스하지 않도록 구분한다. */
  focusEventSessionId: string | null;

  /** 같은 이벤트를 다시 선택한 요청과 이전 highlight timer를 구분한다. 세션 데이터로 저장하지 않는다. */
  focusEventRequestId: number;

  /** 세션 다중 선택 ID 집합 */
  selectedSessionIds: Set<string>;

  /** Shift+클릭 범위 기준점 */
  lastSelectedSessionId: string | null;

  /** 인라인 편집 중인 세션 */
  editingSessionId: string | null;

  /** 모바일 활성 탭 */
  activeTab: MobileTab;

  /** 데스크톱 좌측 탐색 패널 모드 */
  leftNavigationMode: LeftNavigationMode;

  /** 대시보드 배경 설정. 정본 localStorage 키: soul-wallpaper */
  wallpaper: WallpaperSettings;

  /** 리퀴드 글래스 설정. 계정 preferences glass가 정본이다. */
  liquidGlass: LiquidGlassSettings;

  /** 채팅 본문 글자 크기. 계정 preferences chatFontSize가 정본이다. */
  chatFontSize: ChatFontSize;

  /** 오른쪽 Chat 슬롯에 표시 중인 보드 마크다운 문서 */
  activeBoardDocumentId: string | null;

  /** 오른쪽 Chat 슬롯에 표시 중인 커스텀 뷰 */
  activeCustomViewId: string | null;

  /** 폴더 카탈로그 상태 */
  catalog: CatalogState | null;

  /** 선택된 폴더 ID (null = 미분류) */
  selectedFolderId: string | null;

  /** 실제 보드 렌더링 대상 컨테이너. 폴더 트리 선택과 분리한다. */
  activeBoardContainer: BoardContainerRef | null;

  /** 카탈로그 변경 감지용 카운터 */
  catalogVersion: number;

  /** 폴더 목록 정렬 모드 (localStorage에 저장) */
  folderSortMode: FolderSortMode;

  /**
   * 업무 보드 워크스페이스의 마지막 레이아웃 상태 (task page id를 키로 localStorage 영속).
   * 좌·우 패널 폭, 열린 자료 탭, 보드 zoom/pan, 편집 오버레이 상태, 활성 채팅 세션을 담는다.
   * 재진입 시 근사 복원하며, 삭제된 문서/세션 참조는 소비 측에서 정리한다.
   */
  taskBoardLayouts: Record<string, TaskBoardLayoutSnapshot>;
}

/** 업무 보드 레이아웃 스냅샷 — 삭제 대상은 복원 시 안전 폴백한다. */
export interface TaskBoardLayoutSnapshot {
  /** 좌측 자료 패널 폭 (px) */
  resourceWidth?: number;
  /** 우측 채팅 패널 폭 (px) */
  chatWidth?: number;
  /** 활성 자료 탭 id (checklist/sessions/document:.../custom-view:...) */
  activeTabId?: string;
  /** 열린 문서·Flux 탭 목록·순서 */
  openedResources?: { kind: "document" | "custom_view"; resourceId: string }[];
  /** 보드 zoom 배율 */
  boardZoom?: number;
  /** 보드 스크롤 가로 위치 */
  boardScrollLeft?: number;
  /** 보드 스크롤 세로 위치 */
  boardScrollTop?: number;
  /** 편집 오버레이 열림 여부 */
  overlayOpen?: boolean;
  /** 편집 오버레이 확장(95%) 여부 */
  overlayExpanded?: boolean;
  /** 편집 오버레이 가로 오프셋 (px, 0 = 중앙) */
  overlayOffsetX?: number;
  /** 편집 오버레이의 활성 문서 id */
  overlayDocumentId?: string | null;
  /** 우측 활성 채팅 세션 key */
  activeSessionKey?: string | null;
}

// === Actions Interface ===

export interface DashboardActions {
  // 활성 세션
  setActiveSession: (key: string | null, detail?: SessionDetail) => void;
  setActiveSessionSummary: (summary: SessionSummary | null) => void;

  // SSE 이벤트 처리
  processEvent: (
    event: SoulSSEEvent,
    eventId: number,
  ) => void;

  // SSE 이벤트 배치 처리 (히스토리 리플레이 최적화: N개 이벤트를 트리에 적용 후 set() 1회)
  processEvents: (
    events: Array<{ event: SoulSSEEvent; eventId: number }>,
  ) => void;

  /**
   * 히스토리 prepend 처리 — messages API에서 받은 raw 이벤트들을 store.tree에 통합한다.
   *
   * Phase 2-A 평탄화 후: tree-placer가 root.children 평면 push만 하므로 historyMode 분기
   * 없이 라이브 SSE와 동일 파이프라인을 사용한다. processingCtx.activeTextTarget만 잠시
   * 격리(try/finally)하여 prepend 페이지의 handleTextStart가 라이브 text 스트림 노드를
   * 덮어쓰지 않도록 한다.
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
    backend?: string | null,
    boardPosition?: { x: number; y: number } | null,
  ) => void;

  // New Session 모달
  openNewSessionModal: (
    source?: "folder" | "feed",
    defaults?: NewSessionDefaults | null,
  ) => void;
  closeNewSessionModal: () => void;

  // 상태 초기화
  clearTree: () => void;
  reset: () => void;

  // 오른쪽 패널 탭
  setActiveRightTab: (tab: "detail" | "chat" | "info") => void;
  setActiveBoardDocument: (documentId: string | null) => void;
  setActiveCustomView: (customViewId: string | null) => void;

  // input_request 타임아웃 만료 처리
  expireInputRequest: (nodeId: string) => void;

  // draft 저장/삭제
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;

  // prompt_suggestion (chip) 저장/삭제
  setPromptSuggestion: (sessionId: string, text: string | null) => void;
  clearPromptSuggestion: (sessionId: string) => void;

  // 검색 포커스 이벤트 ID
  setFocusEventId: (
    eventId: number | null,
    sessionId?: string,
    target?: ChatFocusTarget,
  ) => void;
  setHistoryCursor: (snapshot: HistoryCursorSnapshot | null) => void;

  // 뷰 모드 (URL 동기화 전용)
  setViewMode: (mode: DashboardViewMode) => void;
  setFeedScrollOffset: (offset: number) => void;
  openTaskBoard: (taskId: string, parentFolderId?: string | null) => void;

  // 카탈로그
  setCatalog: (catalog: CatalogState) => void;
  selectFolder: (folderId: string | null) => void;
  clearSelectedFolder: () => void;
  moveSessionsToFolder: (sessionIds: string[], folderId: string | null) => void;
  renameSession: (sessionId: string, displayName: string | null) => void;
  addFolder: (folder: CatalogFolder) => void;
  setBoardItemsForFolder: (folderId: string, boardItems: CatalogBoardItem[]) => void;
  setBoardItemsForContainer: (container: BoardContainerRef, boardItems: CatalogBoardItem[]) => void;
  addBoardItem: (boardItem: CatalogBoardItem) => void;
  updateBoardItemPosition: (boardItemId: string, x: number, y: number) => void;
  removeBoardItem: (boardItemId: string) => void;
  updateFolderName: (folderId: string, name: string) => void;
  updateFolderSettings: (
    folderId: string,
    settings: CatalogFolder["settings"],
  ) => void;
  removeFolder: (folderId: string) => void;
  /** 폴더 부모/순서 낙관적 갱신 */
  reorderFolders: (items: CatalogFolderReorderItem[]) => void;

  // 폴더 정렬 모드
  setFolderSortMode: (mode: FolderSortMode) => void;

  // 업무 보드 레이아웃 (task page id 키, 부분 병합 저장)
  setTaskBoardLayout: (taskPageId: string, patch: Partial<TaskBoardLayoutSnapshot>) => void;

  // 모바일 탭 전환
  setActiveTab: (tab: MobileTab) => void;

  // 데스크톱 좌측 탐색 패널 전환
  setLeftNavigationMode: (mode: LeftNavigationMode) => void;

  // 배경 설정
  setWallpaper: (settings: WallpaperSettings) => void;
  setWallpaperMode: (mode: WallpaperMode) => void;
  setWallpaperCustomImage: (file: File) => Promise<void>;

  // 리퀴드 글래스 설정
  setLiquidGlass: (settings: Partial<LiquidGlassSettings>) => void;
  setLiquidGlassEnabled: (enabled: boolean) => void;

  // 채팅 본문 글자 크기
  setChatFontSize: (fontSize: ChatFontSize | number) => void;

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
