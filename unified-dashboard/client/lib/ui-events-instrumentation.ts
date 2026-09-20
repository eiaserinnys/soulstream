/**
 * 화면 전환 사용 로그.
 *
 * V3 레이아웃은 hash 라우팅을 쓰지 않으므로(`useUrlSync`는 v1 전용) 전환의
 * 단일 수렴점은 라우터가 아니라 **dashboard store** 다. zustand 구독은
 * `(state, prevState)`를 주므로 "이전 화면"이 공짜로 나온다.
 *
 * 핵심 제약: store 는 SSE 수신으로도 쉴 새 없이 갱신된다. 아래 네비게이션
 * 필드가 실제로 바뀐 경우에만 반응해야 자동 트래픽이 조작으로 기록되지 않는다.
 */
import type { UiEventDraft, UiEventTargetKind, UiEventTracker }
  from "@seosoyoung/soul-ui";

/** 화면이 어디인지 정하는 필드. 여기 없는 필드의 변화는 전환이 아니다. */
export type NavigationSnapshot = {
  readonly viewMode: string | null;
  readonly activeSessionKey: string | null;
  readonly activeBoardContainerKind: string | null;
  readonly activeBoardContainerId: string | null;
  readonly activeBoardDocumentId: string | null;
  readonly activeCustomViewId: string | null;
  readonly selectedFolderId: string | null;
};

type StoreLike = {
  readonly viewMode?: unknown;
  readonly activeSessionKey?: unknown;
  readonly activeBoardContainer?: unknown;
  readonly activeBoardDocumentId?: unknown;
  readonly activeCustomViewId?: unknown;
  readonly selectedFolderId?: unknown;
};

export function navigationSnapshot(state: StoreLike): NavigationSnapshot {
  const container = isRecord(state.activeBoardContainer) ? state.activeBoardContainer : null;
  return {
    viewMode: text(state.viewMode),
    activeSessionKey: text(state.activeSessionKey),
    activeBoardContainerKind: container === null ? null : text(container.kind),
    activeBoardContainerId: container === null ? null : text(container.id),
    activeBoardDocumentId: text(state.activeBoardDocumentId),
    activeCustomViewId: text(state.activeCustomViewId),
    selectedFolderId: text(state.selectedFolderId),
  };
}

export type NavigationTarget = { readonly kind: UiEventTargetKind; readonly id: string };

/**
 * 어느 화면으로 갔는지 하나만 고른다.
 *
 * `openTaskBoard` 처럼 한 번의 `set()` 이 여러 필드를 동시에 바꾸는 경우가 있어
 * 바뀐 필드마다 이벤트를 내면 한 번의 이동이 여러 건으로 부풀어 오른다.
 * 가장 구체적인 대상 하나만 남긴다.
 */
export function resolveNavigationTarget(
  previous: NavigationSnapshot,
  next: NavigationSnapshot,
): NavigationTarget | null {
  if (next.activeSessionKey !== null && next.activeSessionKey !== previous.activeSessionKey) {
    return { kind: "session", id: next.activeSessionKey };
  }
  if (
    next.activeBoardContainerId !== null &&
    (next.activeBoardContainerId !== previous.activeBoardContainerId ||
      next.activeBoardContainerKind !== previous.activeBoardContainerKind)
  ) {
    return {
      kind: next.activeBoardContainerKind === "task" ? "task" : "folder",
      id: next.activeBoardContainerId,
    };
  }
  if (
    next.activeBoardDocumentId !== null &&
    next.activeBoardDocumentId !== previous.activeBoardDocumentId
  ) {
    return { kind: "document", id: next.activeBoardDocumentId };
  }
  if (
    next.activeCustomViewId !== null &&
    next.activeCustomViewId !== previous.activeCustomViewId
  ) {
    return { kind: "custom_view", id: next.activeCustomViewId };
  }
  if (next.selectedFolderId !== null && next.selectedFolderId !== previous.selectedFolderId) {
    return { kind: "folder", id: next.selectedFolderId };
  }
  if (next.viewMode !== null && next.viewMode !== previous.viewMode) {
    return { kind: "view", id: next.viewMode };
  }
  return null;
}

export type StoreSubscribable<T> = {
  readonly getState: () => T;
  readonly subscribe: (listener: (state: T, previous: T) => void) => () => void;
};

/**
 * store 를 구독해 화면 전환마다 `view_open` 하나를 남긴다.
 *
 * `from` 은 직전에 실제로 기록한 대상이다. 필드별 이전값이 아니라
 * "바로 전에 보고 있던 화면"이어야 사람이 읽는 타임라인과 맞는다.
 */
export function subscribeNavigationUiEvents<T extends StoreLike>(
  store: StoreSubscribable<T>,
  track: UiEventTracker,
): () => void {
  let lastTarget: NavigationTarget | null = null;
  let previous = navigationSnapshot(store.getState());

  return store.subscribe((state) => {
    const next = navigationSnapshot(state);
    const target = resolveNavigationTarget(previous, next);
    previous = next;
    if (target === null) return;

    const draft: UiEventDraft = {
      target,
      ...(lastTarget === null ? {} : { from: lastTarget }),
    };
    lastTarget = target;
    // entry 를 비워 두면 수집기가 직전 클릭이 남긴 힌트를 집어 간다.
    track("view_open", draft);
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
