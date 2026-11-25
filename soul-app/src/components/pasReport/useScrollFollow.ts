// 카드 #1871: 일반 ScrollView의 맨 아래 따라가기. 채팅 목록용 useChatBottomFollow는 뒤집힌 FlatList 전용이라 따로 둔다.
// 맨 아래에서 켜진 채 열리고, 내용이 늘면 따라 내려간다. 사용자가 위로 올리면 꺼지고(알약이 뜬다),
// 알약을 누르거나 맨 아래까지 내리면 다시 켜진다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

/** 맨 아래로 치는 거리(pt). 소수점 오차와 관성 끝의 흔들림을 받는다. */
export const FOLLOW_BOTTOM_THRESHOLD = 24;

export function isNearBottom(offsetY: number, viewportHeight: number, contentHeight: number, threshold = FOLLOW_BOTTOM_THRESHOLD) {
  return contentHeight - (offsetY + viewportHeight) <= threshold;
}

/** resetKey가 바뀌면(안건을 바꾸면) 다시 맨 아래에서 시작한다. */
export function useScrollFollow(resetKey: string | null) {
  const scrollRef = useRef<ScrollView>(null);
  const followRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const geometry = useRef({ viewport: 0, content: 0, offset: 0 });
  const dragging = useRef(false);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const setFollowing = useCallback((next: boolean) => {
    followRef.current = next;
    setFollowingState(current => current === next ? current : next);
  }, []);
  const scrollToEnd = useCallback((animated = false) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      scrollRef.current?.scrollToEnd({ animated });
    });
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  useEffect(() => {
    geometry.current.offset = 0;
    setFollowing(true);
    scrollToEnd();
  }, [resetKey, scrollToEnd, setFollowing]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    geometry.current.content = height;
    if (followRef.current) scrollToEnd();
  }, [scrollToEnd]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    geometry.current.viewport = event.nativeEvent.layout.height;
    if (followRef.current) scrollToEnd();
  }, [scrollToEnd]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previous = geometry.current;
    const sameContent = contentSize.height === previous.content;
    const movedUp = contentOffset.y < previous.offset - 1;
    geometry.current = { viewport: layoutMeasurement.height, content: contentSize.height, offset: contentOffset.y };
    if (isNearBottom(contentOffset.y, layoutMeasurement.height, contentSize.height)) { setFollowing(true); return; }
    // 내용이 늘어난 프로그램 스크롤은 위로 가지 않는다. 같은 내용에서 위로 움직였거나 끌고 있으면 사용자가 올린 것이다.
    if (dragging.current || (sameContent && movedUp)) setFollowing(false);
  }, [setFollowing]);
  const onScrollBeginDrag = useCallback(() => { dragging.current = true; }, []);
  const onScrollEnd = useCallback(() => { dragging.current = false; }, []);
  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    scrollToEnd(true);
  }, [scrollToEnd, setFollowing]);

  return {
    scrollRef, following, jumpToLatest,
    scrollProps: {
      onContentSizeChange, onLayout, onScroll, onScrollBeginDrag, onScrollEndDrag: onScrollEnd, onMomentumScrollEnd: onScrollEnd,
      scrollEventThrottle: 16,
    },
  };
}
