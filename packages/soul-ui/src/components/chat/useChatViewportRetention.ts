import {
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

import { areMessageGroupsRenderEqual, messageOrGroupKey } from "./ChatView.reverse-helpers";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";
import {
  measureChatItemOffset,
  measureFirstVisuallyIntersectingItem,
  type ChatViewportAnchor,
} from "./ChatView.viewport-geometry";

const USER_VIEWPORT_INPUT_EVENTS = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;

interface ChatViewportRetentionOptions {
  activeSessionKey: string | null;
  grouped: ChatTimelineItem[];
  firstItemIndex: number;
  isFollowing: boolean;
  recordFirstVisibleKey: (key: string | null) => void;
}

/**
 * Virtuoso의 공개 scroller DOM과 렌더 행 geometry만으로 실제 first-visible
 * stable key를 추적하고, 과거를 읽는 동안 위쪽 행 높이가 변해도 그 key의
 * viewport offset을 보존한다. Virtuoso 내부 range/비공개 API에는 의존하지 않는다.
 */
export function useChatViewportRetention({
  activeSessionKey,
  grouped,
  firstItemIndex,
  isFollowing,
  recordFirstVisibleKey,
}: ChatViewportRetentionOptions) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const firstVisibleFrameRef = useRef<number | null>(null);
  const viewportAnchorRef = useRef<ChatViewportAnchor | null>(null);
  const retentionTargetRef = useRef<ChatViewportAnchor | null>(null);
  const retentionFrameRef = useRef<number | null>(null);
  const scrollObservationPendingRef = useRef(false);
  const pendingScrollAnchorRef = useRef<ChatViewportAnchor | null>(null);
  const retargetAfterUserScrollRef = useRef(false);
  const previousGroupedRef = useRef(grouped);
  const previousFirstItemIndexRef = useRef(firstItemIndex);
  const previousSessionKeyRef = useRef(activeSessionKey);
  const recordFirstVisibleKeyRef = useRef(recordFirstVisibleKey);
  recordFirstVisibleKeyRef.current = recordFirstVisibleKey;

  const recordVisuallyFirstItem = useCallback(() => {
    if (retentionTargetRef.current !== null) return;
    scrollObservationPendingRef.current = false;
    pendingScrollAnchorRef.current = null;
    retargetAfterUserScrollRef.current = false;
    const scroller = scrollerRef.current;
    const anchor = scroller === null
      ? null
      : measureFirstVisuallyIntersectingItem(scroller);
    viewportAnchorRef.current = anchor;
    if (scroller !== null) {
      scroller.dataset.chatFirstVisibleKey = anchor?.key ?? "";
    }
    recordFirstVisibleKeyRef.current(anchor?.key ?? null);
  }, []);

  const scheduleVisuallyFirstItem = useCallback(() => {
    if (firstVisibleFrameRef.current !== null) {
      window.cancelAnimationFrame(firstVisibleFrameRef.current);
    }
    firstVisibleFrameRef.current = window.requestAnimationFrame(() => {
      // Virtuoso가 native scroll 뒤 overscan 행을 재활용하는 첫 frame과 React의
      // external-store commit이 경쟁할 수 있다. 두 번째 frame에서 확정 geometry를
      // 기록하되, 그 전에 data commit이 오면 아래 sync pending anchor를 사용한다.
      firstVisibleFrameRef.current = window.requestAnimationFrame(() => {
        firstVisibleFrameRef.current = null;
        recordVisuallyFirstItem();
      });
    });
  }, [recordVisuallyFirstItem]);

  const beginViewportRetention = useCallback((target: ChatViewportAnchor) => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    if (retentionFrameRef.current !== null) {
      window.cancelAnimationFrame(retentionFrameRef.current);
      retentionFrameRef.current = null;
    }
    scrollObservationPendingRef.current = false;
    pendingScrollAnchorRef.current = null;
    retargetAfterUserScrollRef.current = false;
    retentionTargetRef.current = target;
    scroller.dataset.chatViewportRetentionTargetKey = target.key;
    scroller.dataset.chatViewportRetentionPending = "true";
    scroller.dataset.chatViewportRetentionCorrection = "0";
    scroller.dataset.chatViewportRetentionStarts = String(
      Number(scroller.dataset.chatViewportRetentionStarts ?? "0") + 1,
    );
    // Virtuoso의 ResizeObserver와 spacer 보정은 data commit 뒤 여러 frame에 걸칠 수 있다.
    // 한두 frame만 보면 중간 spacer 좌표를 최종값으로 오인하므로 짧은 settle window 동안
    // 같은 stable key의 offset을 유지한다.
    let remainingPasses = 8;
    const preserveObservedViewport = () => {
      if (retentionTargetRef.current !== target) return;
      const currentOffset = measureChatItemOffset(scroller, target.key);
      // 큰 history prepend로 target DOM이 overscan 밖으로 밀리면 공개 scrollHeight
      // 증가분으로 먼저 같은 절대 좌표를 복원한다. target이 다시 렌더되면 아래
      // geometry 경로가 실제 offset 오차를 마무리한다.
      const delta = currentOffset === null
        ? target.scrollTop
          + (scroller.scrollHeight - target.scrollHeight)
          - scroller.scrollTop
        : currentOffset - target.offset;
      if (Math.abs(delta) >= 0.5) {
        scroller.scrollTop += delta;
        const accumulated = Number(
          scroller.dataset.chatViewportRetentionCorrection ?? "0",
        );
        scroller.dataset.chatViewportRetentionCorrection = String(
          accumulated + delta,
        );
      }
      remainingPasses -= 1;
      if (remainingPasses > 0) {
        retentionFrameRef.current = window.requestAnimationFrame(
          preserveObservedViewport,
        );
        return;
      }
      retentionFrameRef.current = null;
      retentionTargetRef.current = null;
      scroller.dataset.chatViewportRetentionPending = "false";
      recordVisuallyFirstItem();
    };
    retentionFrameRef.current = window.requestAnimationFrame(
      preserveObservedViewport,
    );
  }, [recordVisuallyFirstItem]);

  const observeAfterScroll = useCallback(() => {
    if (retentionTargetRef.current !== null) return;
    // Virtuoso는 native scroll 뒤 렌더 행을 재활용하므로 이벤트 순간 DOM은 최종 행이
    // 아닐 수 있다. 다만 다음 frame 전에 data가 바뀌면 이 순간 사용자가 실제로 본
    // stable key/offset을 race target으로 사용하고, 아니면 rAF 관찰값으로 교체한다.
    const scroller = scrollerRef.current;
    pendingScrollAnchorRef.current = scroller === null
      ? null
      : measureFirstVisuallyIntersectingItem(scroller);
    scrollObservationPendingRef.current = true;
    if (
      retargetAfterUserScrollRef.current
    ) {
      // data commit 뒤 spacer가 아직 settle 중일 때 사용자가 움직이면 이전 target은
      // 즉시 폐기한다. Virtuoso가 scroll event 뒤 같은 task의 microtask에서 공개 DOM을
      // 재활용한 다음 새 user target을 잡아 남은 ResizeObserver pass에 다시 밀리지 않게 한다.
      queueMicrotask(() => {
        if (
          scrollerRef.current !== scroller
          || !retargetAfterUserScrollRef.current
          || retentionTargetRef.current !== null
        ) return;
        const userTarget = scroller === null
          ? null
          : measureFirstVisuallyIntersectingItem(scroller);
        if (userTarget === null) {
          retargetAfterUserScrollRef.current = false;
          scheduleVisuallyFirstItem();
          return;
        }
        beginViewportRetention(userTarget);
      });
      return;
    }
    // 이 listener가 Virtuoso의 scroll listener보다 먼저 등록됐다면 동기 geometry는
    // 아직 재활용 전 행일 수 있다. 같은 scroll task의 모든 listener가 끝난 직후,
    // rAF보다 앞선 microtask에서 공개 DOM을 한 번 더 읽어 pending 기준만 갱신한다.
    queueMicrotask(() => {
      if (
        scrollerRef.current !== scroller
        || !scrollObservationPendingRef.current
        || retentionTargetRef.current !== null
      ) return;
      pendingScrollAnchorRef.current = scroller === null
        ? null
        : measureFirstVisuallyIntersectingItem(scroller);
    });
    scheduleVisuallyFirstItem();
  }, [beginViewportRetention, scheduleVisuallyFirstItem]);

  const cancelRetentionForUserInput = useCallback(() => {
    const shouldRetarget = retentionTargetRef.current !== null;
    if (retentionFrameRef.current !== null) {
      window.cancelAnimationFrame(retentionFrameRef.current);
      retentionFrameRef.current = null;
    }
    retentionTargetRef.current = null;
    scrollObservationPendingRef.current = true;
    pendingScrollAnchorRef.current = null;
    retargetAfterUserScrollRef.current = shouldRetarget;
    const scroller = scrollerRef.current;
    if (scroller !== null) {
      scroller.dataset.chatViewportRetentionPending = "false";
    }
    scheduleVisuallyFirstItem();
  }, [scheduleVisuallyFirstItem]);

  const bindScrollerElement = useCallback((ref: HTMLElement | Window | null) => {
    const previous = scrollerRef.current;
    previous?.removeEventListener("scroll", observeAfterScroll);
    for (const eventName of USER_VIEWPORT_INPUT_EVENTS) {
      previous?.removeEventListener(eventName, cancelRetentionForUserInput);
    }
    if (firstVisibleFrameRef.current !== null) {
      window.cancelAnimationFrame(firstVisibleFrameRef.current);
      firstVisibleFrameRef.current = null;
    }
    if (retentionFrameRef.current !== null) {
      window.cancelAnimationFrame(retentionFrameRef.current);
      retentionFrameRef.current = null;
    }
    retentionTargetRef.current = null;
    scrollObservationPendingRef.current = false;
    pendingScrollAnchorRef.current = null;
    retargetAfterUserScrollRef.current = false;
    viewportAnchorRef.current = null;
    const element = ref instanceof HTMLElement ? ref : null;
    scrollerRef.current = element;
    if (element === null) return;
    element.dataset.chatScroller = "true";
    element.dataset.chatViewportRetentionPending = "false";
    element.dataset.chatViewportRetentionStarts = "0";
    // native scroll과 itemsRendered는 두 frame 뒤 최종 재활용 행을 기록한다. 그 전에
    // data가 commit되면 scroll event 순간의 pending geometry를 보존 기준으로 쓴다.
    element.addEventListener("scroll", observeAfterScroll, { passive: true });
    for (const eventName of USER_VIEWPORT_INPUT_EVENTS) {
      element.addEventListener(eventName, cancelRetentionForUserInput, { passive: true });
    }
    scheduleVisuallyFirstItem();
  }, [cancelRetentionForUserInput, observeAfterScroll, scheduleVisuallyFirstItem]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const activeTarget = retentionTargetRef.current;
    const target = activeTarget
      ?? (scrollObservationPendingRef.current
        ? pendingScrollAnchorRef.current
        : viewportAnchorRef.current);
    const previousGrouped = previousGroupedRef.current;
    const previousFirstItemIndex = previousFirstItemIndexRef.current;
    const isSameSession = previousSessionKeyRef.current === activeSessionKey;
    previousGroupedRef.current = grouped;
    previousFirstItemIndexRef.current = firstItemIndex;
    previousSessionKeyRef.current = activeSessionKey;
    const previousTargetIndex = target === null
      ? -1
      : previousGrouped.findIndex((item) => messageOrGroupKey(item) === target.key);
    const nextTargetIndex = target === null
      ? -1
      : grouped.findIndex((item) => messageOrGroupKey(item) === target.key);
    const rowsBeforeTargetChanged =
      previousTargetIndex >= 0
      && nextTargetIndex >= 0
      && !areMessageGroupsRenderEqual(
        previousGrouped.slice(0, previousTargetIndex),
        grouped.slice(0, nextTargetIndex),
      );
    const coordinateChanged = previousFirstItemIndex !== firstItemIndex;
    const needsRetention = isSameSession
      && (coordinateChanged || rowsBeforeTargetChanged);
    if (scroller !== null) {
      scroller.dataset.chatViewportRetentionTargetKey = target?.key ?? "";
      scroller.dataset.chatViewportRetentionRowsBeforeChanged = String(
        rowsBeforeTargetChanged,
      );
      scroller.dataset.chatViewportRetentionCoordinateChanged = String(
        coordinateChanged,
      );
      scroller.dataset.chatViewportRetentionFollowing = String(
        isFollowing,
      );
    }
    if (!isSameSession || isFollowing) {
      if (retentionFrameRef.current !== null) {
        window.cancelAnimationFrame(retentionFrameRef.current);
        retentionFrameRef.current = null;
      }
      retentionTargetRef.current = null;
      if (scroller !== null) {
        scroller.dataset.chatViewportRetentionPending = "false";
        scroller.dataset.chatViewportRetentionCorrection = "0";
      }
      scheduleVisuallyFirstItem();
      return;
    }
    // 같은 세션의 first-visible 뒤 text_delta, duplicate, 미로딩 summary는 진행 중인
    // settle window를 취소하지 않는다. 이 update 자체가 새 보정을 요구하지 않을 뿐,
    // 직전 과거 삽입의 ResizeObserver/spacer 보정은 아직 끝나지 않았을 수 있다.
    if (!needsRetention && activeTarget !== null) return;
    if (scroller === null || target === null || !needsRetention) {
      retentionTargetRef.current = null;
      if (scroller !== null) {
        scroller.dataset.chatViewportRetentionPending = "false";
        scroller.dataset.chatViewportRetentionCorrection = "0";
      }
      scheduleVisuallyFirstItem();
      return;
    }

    beginViewportRetention(target);
  }, [
    activeSessionKey,
    beginViewportRetention,
    firstItemIndex,
    grouped,
    isFollowing,
    recordVisuallyFirstItem,
    scheduleVisuallyFirstItem,
  ]);

  return {
    scrollerRef,
    bindScrollerElement,
    scheduleVisuallyFirstItem,
  };
}
