import { useCallback, useEffect, useRef } from 'react';
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
}: UseChatBottomFollowArgs) {
  const isAtBottomRef = useRef(true);
  const pendingBottomRef = useRef(false);
  const previousBottomItemKeyRef = useRef<string | null>(null);
  const contentMeasuredRef = useRef(false);
  const scrollFrameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

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
    scheduleBottomScroll();
  }, [scheduleBottomScroll]);

  const suspendBottomFollow = useCallback(() => {
    isAtBottomRef.current = false;
    pendingBottomRef.current = false;
    cancelScheduledScroll();
  }, [cancelScheduledScroll]);

  const onScrollOffsetChange = useCallback((offsetY: number) => {
    const isAtBottom = isNearInvertedListBottom(offsetY);
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) pendingBottomRef.current = false;
  }, []);

  const onContentSizeChange = useCallback((height: number) => {
    if (height <= 0) return;
    if (!contentMeasuredRef.current) {
      contentMeasuredRef.current = true;
      flatListRef.current?.recordInteraction();
    }
    if (isAtBottomRef.current || pendingBottomRef.current) {
      scheduleBottomScroll();
    }
  }, [flatListRef, scheduleBottomScroll]);

  useEffect(() => {
    isAtBottomRef.current = true;
    pendingBottomRef.current = false;
    previousBottomItemKeyRef.current = null;
    contentMeasuredRef.current = false;
    cancelScheduledScroll();
    return cancelScheduledScroll;
  }, [cancelScheduledScroll, sessionId]);

  useEffect(() => {
    const previousKey = previousBottomItemKeyRef.current;
    previousBottomItemKeyRef.current = bottomItemKey;
    if (!shouldFollowNewBottomItem({
      wasAtBottom: isAtBottomRef.current || pendingBottomRef.current,
      previousKey,
      nextKey: bottomItemKey,
    })) return;
    scheduleBottomScroll();
  }, [bottomItemKey, scheduleBottomScroll, sessionId]);

  return {
    requestBottomFollow,
    suspendBottomFollow,
    onScrollBeginDrag: suspendBottomFollow,
    onScrollOffsetChange,
    onContentSizeChange,
  };
}
