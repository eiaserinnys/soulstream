/**
 * ChatView virtualizer의 estimateSize 콜백을 제공하는 훅.
 *
 * - ResizeObserver로 containerWidth를 추적하여 텍스트 wrapping 계산에 반영
 * - 세션 변경 시 prepare 캐시를 클리어
 * - grouped 배열의 ref를 사용하여 콜백 안정성 유지
 */

import { useRef, useCallback, useEffect, useState } from "react";
import type { MessageOrGroup } from "../components/chat/grouping";
import { estimateItemHeight, clearPrepareCache } from "../lib/estimate-height";

export function useEstimateSize(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  grouped: MessageOrGroup[],
  activeSessionKey: string | null,
) {
  const [containerWidth, setContainerWidth] = useState(600);
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;

  // containerWidth 추적 (2px 이상 변동만 반영하여 sub-pixel 변동에 의한 재계산 방지)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      setContainerWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
    });
    ro.observe(el);
    setContainerWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, [scrollRef]);

  // 세션 변경 시 캐시 클리어
  useEffect(() => {
    clearPrepareCache();
  }, [activeSessionKey]);

  const estimateSize = useCallback(
    (index: number) => {
      const item = groupedRef.current[index];
      if (!item) return 80;
      return estimateItemHeight(item, containerWidth);
    },
    [containerWidth],
  );

  return estimateSize;
}
