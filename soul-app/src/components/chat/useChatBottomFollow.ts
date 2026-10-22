import { useOptionalLayoutContinuity } from '../../navigation/LayoutContinuityContext';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FlatList } from 'react-native';
import type { ChatRenderItem } from './groupChatEvents';
import {
  isNearInvertedListBottom,
  shouldFollowNewBottomItem,
} from './bottomFollow';

interface UseChatBottomFollowArgs {
  flatListRef: React.RefObject<FlatList<ChatRenderItem> | null>;
  sessionId: string | undefined;
  bottomItemKey: string | null;
  presentation?: 'default' | 'manuscript';
  ready?: boolean;
}

/**
 * inverted FlatList의 시각적 하단(offset=0) 추적을 한 경로로 제어한다.
 *
 * 항목 key 변경뿐 아니라 같은 streaming slot의 높이 증가도 추적한다. 이동 명령은
 * 실제 onScroll이 하단 도착을 확인할 때까지 pending이며, 사용자의 drag만 추적을
 * 명시적으로 중단한다. 시간 cooldown은 사용하지 않고 animation frame 하나만 합친다.
 */
export function useChatBottomFollow({
  flatListRef,
  sessionId,
  bottomItemKey,
  presentation = 'default',
  ready = true,
}: UseChatBottomFollowArgs) {
  const continuity = useOptionalLayoutContinuity();
  const memoryKey = JSON.stringify(['chat', sessionId]);
  const saved = continuity?.readScroll(memoryKey);
  const restorePending = useRef(saved?.followBottom === false ? saved : undefined);
  const offsetRef = useRef(saved?.offsetY ?? 0);
  const geometry = useRef({ height: 0, content: 0 });
  const restoreReadingPosition = useCallback(() => {
    if (!ready || !restorePending.current || geometry.current.content <= 0) return false;
    const offset = Math.max(0, Math.min(restorePending.current.offsetY, geometry.current.content - geometry.current.height));
    restorePending.current = undefined;
    offsetRef.current = offset;
    flatListRef.current?.scrollToOffset({ offset, animated: false });
    return true;
  }, [flatListRef, ready]);
  const isAtBottomRef = useRef(saved?.followBottom !== false);
  const pendingBottomRef = useRef(false);
  const previousBottomItemKeyRef = useRef<string | null>(null);
  const contentMeasuredRef = useRef(false);
  const scrollFrameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const [showNewMessage, setShowNewMessage] = useState(false);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current === null) return;
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }, []);

  const scheduleBottomScroll = useCallback(() => {
    pendingBottomRef.current = true;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [flatListRef]);

  const requestBottomFollow = useCallback(() => {
    restorePending.current = undefined;
    continuity?.writeScroll(memoryKey, { offsetY: 0, followBottom: true });
    setShowNewMessage(false);
    scheduleBottomScroll();
  }, [continuity, memoryKey, scheduleBottomScroll]);

  const suspendBottomFollow = useCallback(() => {
    restorePending.current = undefined;
    continuity?.writeScroll(memoryKey, { offsetY: offsetRef.current, followBottom: false });
    isAtBottomRef.current = false;
    pendingBottomRef.current = false;
    cancelScheduledScroll();
  }, [cancelScheduledScroll, continuity, memoryKey]);

  const onScrollOffsetChange = useCallback((offsetY: number) => {
    if (restorePending.current) return;
    offsetRef.current = offsetY;
    const isAtBottom = isNearInvertedListBottom(offsetY);
    continuity?.writeScroll(memoryKey, { offsetY, followBottom: isAtBottom });
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) {
      pendingBottomRef.current = false;
      setShowNewMessage(false);
    }
  }, [continuity, memoryKey]);

  const onContentSizeChange = useCallback((height: number) => {
    if (height <= 0) return;
    if (!contentMeasuredRef.current) {
      contentMeasuredRef.current = true;
      flatListRef.current?.recordInteraction();
    }
    geometry.current.content = height;
    if (restorePending.current) { restoreReadingPosition(); return; }
    if (isAtBottomRef.current || pendingBottomRef.current) {
      scheduleBottomScroll();
    }
  }, [flatListRef, restoreReadingPosition, scheduleBottomScroll]);

  useLayoutEffect(() => { restoreReadingPosition(); }, [restoreReadingPosition]);

  useEffect(() => {
    const position = continuity?.readScroll(memoryKey);
    restorePending.current = position?.followBottom === false ? position : undefined;
    offsetRef.current = position?.offsetY ?? 0;
    isAtBottomRef.current = position?.followBottom !== false;
    pendingBottomRef.current = false;
    previousBottomItemKeyRef.current = null;
    contentMeasuredRef.current = false;
    setShowNewMessage(false);
    cancelScheduledScroll();
    return cancelScheduledScroll;
  }, [cancelScheduledScroll, continuity, memoryKey, sessionId]);

  useEffect(() => {
    const previousKey = previousBottomItemKeyRef.current;
    previousBottomItemKeyRef.current = bottomItemKey;
    if (shouldFollowNewBottomItem({
      wasAtBottom: isAtBottomRef.current || pendingBottomRef.current,
      previousKey,
      nextKey: bottomItemKey,
    })) {
      setShowNewMessage(false);
      scheduleBottomScroll();
      return;
    }
    if (presentation === 'manuscript' && previousKey && bottomItemKey && previousKey !== bottomItemKey && !isAtBottomRef.current && !pendingBottomRef.current) {
      setShowNewMessage(true);
    }
  }, [bottomItemKey, presentation, scheduleBottomScroll, sessionId]);

  return {
    requestBottomFollow,
    showNewMessage,
    suspendBottomFollow,
    onScrollBeginDrag: suspendBottomFollow,
    onScrollOffsetChange,
    onContentSizeChange,
    onLayout: (height: number) => {
      if (geometry.current.height && geometry.current.height !== height && !isAtBottomRef.current) {
        restorePending.current = { offsetY: offsetRef.current, followBottom: false };
      }
      geometry.current.height = height;
      restoreReadingPosition();
    },
  };
}
