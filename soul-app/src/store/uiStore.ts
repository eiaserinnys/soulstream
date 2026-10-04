import AsyncStorage from '@react-native-async-storage/async-storage';
import { withDiagnosticStateStorage } from './diagnosticStateStorage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { subscribeAuthScope } from '../lib/auth-scope';
import { useSearchStore } from './searchStore';

/**
 * 태블릿 v3 레이아웃에서 좌측 내비·중앙 플래너·우측 세션 패널의 선택 상태와
 * 업무+채팅 오버레이, 가로 모드 패널 폭(드래그 결과)을 관리한다.
 *
 * 폰 레이아웃에서는 react-navigation의 navigation params로 세션을 전달하므로 본 store는
 * 태블릿 SplitLayout 안에서만 사용한다. 단, activeSessionId를 settingsStore와 분리해 둔
 * 이유는 재시작 시 마지막 본 세션 복원 등 향후 확장에 유연하기 위함.
 */

export type ActiveSection =
  | { kind: 'daily'; date: string }
  | { kind: 'project'; folderId: string; projectPageId: string };

export type SessionFolderResolutionState =
  | { sessionId: string; status: 'loading' }
  | { sessionId: string; status: 'unlinked' }
  | {
      sessionId: string;
      status: 'error';
      message: string;
      retryable: boolean;
    }
  | null;

interface UIState {
  /** 포그라운드 복귀 때 다시 계산되는 로컬 오늘 날짜. */
  todayDate: string;
  /** 좌측 사이드바에서 선택된 항목 — 중앙 메인 패널의 내용을 결정. */
  activeSection: ActiveSection;
  /** Nonpersistent middle-pane view choices and floating home composer coverage. */
  mainPaneViews: Record<string, 'existing' | 'board'>;
  setMainPaneView: (key: string, view: 'existing' | 'board') => void;
  floatingComposerBottomInset: number;
  setFloatingComposerBottomInset: (height: number) => void;
  /** 업무/세션 오버레이의 ChatPane에 표시할 세션. null이면 빈 상태. */
  activeSessionId: string | null;
  /** 업무 오버레이 ChatPane에서 스크롤할 이벤트 anchor. */
  focusEventId: number | null;
  /** 검색 결과가 기존 세션 스토리 패널을 펼치도록 보내는 일회성 요청. */
  storyOpenRequestId: number | null;
  /** iPad 업무 오버레이가 읽을 업무=페이지 정본 ID. */
  selectedFolderPageId: string | null;
  selectedCardId: string | null;
  initialCardSessionId: string | null;
  openCardOverlay: (cardId: string, initialSessionId?: string | null) => void;
  clearCardOverlay: () => void;
  /** iPad 설정 모달. 사이드바와 외부 딥링크가 같은 상태를 사용한다. */
  settingsVisible: boolean;
  /** iPad 업무 문맥 또는 세션 단독 채팅 슬라이드 오버레이 표시 여부. */
  folderOverlayVisible: boolean;
  /** Expanded board's native sheet owns the existing detail overlay while mounted. Not persisted. */
  cardBoardExpanded: boolean;
  setCardBoardExpanded: (expanded: boolean) => void;
  /** cache miss 조회를 미소속과 구분하는 session→folder resolver 표시 상태. */
  sessionFolderResolution: SessionFolderResolutionState;
  /** Root search intent survives a retryable linked-folder lookup failure. */
  sessionSearchIntentId: number | null;
  completedSessionSearchIntentId: number | null;
  /** 가로 3-pane에서 좌측 사이드바 폭 (pt). 사용자 드래그 시 persist. */
  paneLeftWidth: number;
  /** 가로 3-pane에서 중앙 플래너 폭 (pt). 우측 세션 패널은 나머지를 가변 점유. */
  paneMiddleWidth: number;

  setActiveSection: (section: ActiveSection) => void;
  refreshTodayDate: (now?: Date) => void;
  setActiveSessionId: (id: string | null) => void;
  openSessionAtEvent: (id: string, eventId?: number | null) => void;
  clearFocusEventId: (sessionId?: string | null, eventId?: number | null) => void;
  clearStoryOpenRequestId: () => void;
  openFolderOverlay: (
    pageId: string,
    sessionId?: string | null,
    eventId?: number | null,
    storyOpenRequestId?: number | null,
  ) => void;
  openResolvingSessionOverlay: (
    sessionId: string,
    eventId?: number | null,
    storyOpenRequestId?: number | null,
  ) => void;
  openSessionOverlay: (
    sessionId: string,
    eventId?: number | null,
    storyOpenRequestId?: number | null,
  ) => void;
  openSessionResolutionError: (
    sessionId: string,
    eventId: number | null,
    message: string,
    retryable: boolean,
    storyOpenRequestId?: number | null,
  ) => void;
  setSessionSearchIntentId: (intentId: number | null) => void;
  completeSessionSearchIntent: (intentId: number) => void;
  clearSessionSearchIntent: (intentId: number) => void;
  cancelSessionResolution: (sessionId: string) => void;
  closeFolderOverlay: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setPaneLeftWidth: (w: number) => void;
  setPaneMiddleWidth: (w: number) => void;
}

type HydrationFailureListener = () => void;

let hydrationFailed = false;
const hydrationFailureListeners = new Set<HydrationFailureListener>();

export function hasUIStoreHydrationFailed(): boolean {
  return hydrationFailed;
}

export function subscribeUIStoreHydrationFailure(
  listener: HydrationFailureListener,
): () => void {
  hydrationFailureListeners.add(listener);
  return () => hydrationFailureListeners.delete(listener);
}

function reportHydrationFailure(error: unknown) {
  hydrationFailed = true;
  console.error('[uiStore] persisted pane width hydration failed', error);
  hydrationFailureListeners.forEach((listener) => listener());
}

const PANE_LEFT_DEFAULT = 240;
// 중앙 플래너는 480pt를 기본으로 두고 우측 세션 패널이 남은 폭을 차지한다.
const PANE_MIDDLE_DEFAULT = 480;

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      todayDate: localDate(),
      activeSection: { kind: 'daily', date: localDate() },
      mainPaneViews: { global: 'board' },
      setMainPaneView: (key, view) => set(state => ({ mainPaneViews: { ...state.mainPaneViews, [key]: view } })),
      floatingComposerBottomInset: 0,
      setFloatingComposerBottomInset: (floatingComposerBottomInset) => set({ floatingComposerBottomInset }),
      activeSessionId: null,
      focusEventId: null,
      storyOpenRequestId: null,
      selectedFolderPageId: null,
      selectedCardId: null,
      initialCardSessionId: null,
      settingsVisible: false,
      folderOverlayVisible: false,
      cardBoardExpanded: false,
      setCardBoardExpanded: (cardBoardExpanded) => set({ cardBoardExpanded }),
      sessionFolderResolution: null,
      sessionSearchIntentId: null,
      completedSessionSearchIntentId: null,
      paneLeftWidth: PANE_LEFT_DEFAULT,
      paneMiddleWidth: PANE_MIDDLE_DEFAULT,

      setActiveSection: (section) => set({ activeSection: section }),
      refreshTodayDate: (now = new Date()) => set((state) => {
        const nextToday = localDate(now);
        if (nextToday === state.todayDate) return state;
        return {
          todayDate: nextToday,
          activeSection: state.activeSection.kind === 'daily'
            && state.activeSection.date === state.todayDate
            ? { kind: 'daily', date: nextToday }
            : state.activeSection,
        };
      }),
      setActiveSessionId: (id) => set({
        activeSessionId: id,
        focusEventId: null,
        storyOpenRequestId: null,
      }),
      openSessionAtEvent: (id, eventId) =>
        set({
          activeSessionId: id,
          focusEventId: eventId ?? null,
          storyOpenRequestId: null,
        }),
      clearFocusEventId: (sessionId, eventId) => set((state) => {
        if (sessionId !== undefined && state.activeSessionId !== sessionId) return state;
        if (eventId !== undefined && state.focusEventId !== eventId) return state;
        return { focusEventId: null };
      }),
      clearStoryOpenRequestId: () => set({ storyOpenRequestId: null }),
      openCardOverlay: (cardId, initialSessionId) => set((state) => ({
        selectedCardId: cardId,
        initialCardSessionId: initialSessionId ?? null,
        folderOverlayVisible: true,
        activeSessionId: initialSessionId ?? state.activeSessionId,
      })),
      clearCardOverlay: () => set({ selectedCardId: null, initialCardSessionId: null }),
      openFolderOverlay: (pageId, sessionId, eventId, storyOpenRequestId) => set((state) => ({
        selectedFolderPageId: pageId,
        selectedCardId: null,
        initialCardSessionId: null,
        folderOverlayVisible: true,
        activeSessionId: sessionId === undefined ? state.activeSessionId : sessionId,
        focusEventId: eventId ?? null,
        storyOpenRequestId: storyOpenRequestId ?? null,
        sessionFolderResolution: null,
      })),
      openResolvingSessionOverlay: (sessionId, eventId, storyOpenRequestId) => set({
        selectedFolderPageId: null,
        selectedCardId: null,
        initialCardSessionId: null,
        folderOverlayVisible: true,
        activeSessionId: sessionId,
        focusEventId: eventId ?? null,
        storyOpenRequestId: storyOpenRequestId ?? null,
        sessionFolderResolution: { sessionId, status: 'loading' },
      }),
      openSessionOverlay: (sessionId, eventId, storyOpenRequestId) => set({
        selectedFolderPageId: null,
        selectedCardId: null,
        initialCardSessionId: null,
        folderOverlayVisible: true,
        activeSessionId: sessionId,
        focusEventId: eventId ?? null,
        storyOpenRequestId: storyOpenRequestId ?? null,
        sessionFolderResolution: { sessionId, status: 'unlinked' },
      }),
      openSessionResolutionError: (
        sessionId,
        eventId,
        message,
        retryable,
        storyOpenRequestId,
      ) => set({
        selectedFolderPageId: null,
        selectedCardId: null,
        initialCardSessionId: null,
        folderOverlayVisible: true,
        activeSessionId: sessionId,
        focusEventId: eventId,
        storyOpenRequestId: storyOpenRequestId ?? null,
        sessionFolderResolution: { sessionId, status: 'error', message, retryable },
      }),
      setSessionSearchIntentId: (intentId) => set({
        sessionSearchIntentId: intentId,
        completedSessionSearchIntentId: null,
      }),
      completeSessionSearchIntent: (intentId) => set((state) => (
        state.sessionSearchIntentId === intentId
          ? { completedSessionSearchIntentId: intentId }
          : state
      )),
      clearSessionSearchIntent: (intentId) => set((state) => (
        state.sessionSearchIntentId === intentId
          ? { sessionSearchIntentId: null, completedSessionSearchIntentId: null }
          : state
      )),
      cancelSessionResolution: (sessionId) => set((state) => {
        if (
          state.activeSessionId !== sessionId
          || state.sessionFolderResolution?.sessionId !== sessionId
          || state.sessionFolderResolution.status !== 'loading'
        ) return state;
        return {
          selectedFolderPageId: null,
          selectedCardId: null,
          initialCardSessionId: null,
          folderOverlayVisible: false,
          activeSessionId: null,
          focusEventId: null,
          storyOpenRequestId: null,
          sessionFolderResolution: null,
          sessionSearchIntentId: null,
          completedSessionSearchIntentId: null,
        };
      }),
      closeFolderOverlay: () => set({
        selectedCardId: null,
        initialCardSessionId: null,
        folderOverlayVisible: false,
        storyOpenRequestId: null,
      }),
      openSettings: () => set({ settingsVisible: true }),
      closeSettings: () => set({ settingsVisible: false }),
      setPaneLeftWidth: (w) => set({ paneLeftWidth: clamp(w, 180, 360) }),
      setPaneMiddleWidth: (w) => set({ paneMiddleWidth: clamp(w, 280, 600) }),
    }),
    {
      name: 'soul-app-ui',
      storage: createJSONStorage(() => withDiagnosticStateStorage(AsyncStorage, 'ui')),
      // 패널 폭만 persist하고 화면·업무·세션 선택은 다음 실행에서 초기화한다.
      partialize: (state) => ({
        paneLeftWidth: state.paneLeftWidth,
        paneMiddleWidth: state.paneMiddleWidth,
      }),
      // 빌드 19: paneMiddleWidth 기본값 360 → 480로 변경. 빌드 18에서 한 번 떴다가
      // 360을 persist한 사용자도 새 기본값을 받게 한다 (스플리터 버그 때문에 그 때
      // 사용자가 직접 360에서 다른 값으로 변경했을 가능성은 0이라 안전).
      version: 1,
      migrate: (persistedState: any, fromVersion: number) => {
        if (fromVersion < 1 && persistedState?.paneMiddleWidth === 360) {
          persistedState.paneMiddleWidth = PANE_MIDDLE_DEFAULT;
        }
        return persistedState;
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) reportHydrationFailure(error);
      },
    }
  )
);

subscribeAuthScope(() => {
  const todayDate = localDate();
  useUIStore.setState({
    todayDate,
    activeSection: { kind: 'daily', date: todayDate },
    mainPaneViews: { global: 'board' },
    floatingComposerBottomInset: 0,
    activeSessionId: null,
    focusEventId: null,
    selectedFolderPageId: null,
    selectedCardId: null,
    settingsVisible: false,
    folderOverlayVisible: false,
    sessionFolderResolution: null,
  });
});

useUIStore.subscribe((state, previousState) => {
  if (
    state.activeSessionId &&
    state.activeSessionId !== previousState.activeSessionId
  ) {
    useSearchStore.getState().rememberSession(state.activeSessionId);
  }
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
