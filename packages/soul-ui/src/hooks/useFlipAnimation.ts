import { useRef, useLayoutEffect, useCallback } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";

/**
 * FLIP 애니메이션 훅
 *
 * react-virtual의 position:absolute + translateY(vi.start) 구조에서,
 * 세션 순서가 변경될 때 카드/행이 현재 위치에서 새 위치로 부드럽게 이동한다.
 *
 * 구조:
 *   outer div — React 소유, translateY(vi.start) 유지 (변경 금지)
 *   inner div — 훅 소유, translateY(delta → 0) 애니메이션 적용
 *
 * setRef로 inner div를 등록하면, 다음 렌더 시 vi.start 변화량(delta)을
 * inner div에 Invert 적용 후 double-rAF로 Play한다.
 */
export function useFlipAnimation<T extends { agentSessionId: string }>(
  items: T[],
  virtualItems: VirtualItem[],
  duration = 200
): { setRef: (id: string, el: HTMLElement | null) => void } {
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevStartMap = useRef<Map<string, number>>(new Map());

  // dependency array 없음 — 의도적 매 렌더 실행
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced) {
      virtualItems.forEach((vi) => {
        const id = items[vi.index]?.agentSessionId;
        if (!id) return;
        const el = itemRefs.current.get(id);
        if (!el) return;

        const prevStart = prevStartMap.current.get(id);
        if (prevStart === undefined) return; // 새 아이템 — 즉시 표시

        const delta = prevStart - vi.start;
        if (Math.abs(delta) < 1) return; // 이동 없음

        // Invert: inner div를 이전 위치(delta)로 순간 이동
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;

        // Play: double rAF로 브라우저가 스타일을 flush한 뒤 transition 적용
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.transition = `transform ${duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
            el.style.transform = "translateY(0)";
          });
        });
      });
    }

    // 스냅샷 갱신 (reduced motion이어도 항상 갱신)
    const newMap = new Map<string, number>();
    virtualItems.forEach((vi) => {
      const id = items[vi.index]?.agentSessionId;
      if (id) newMap.set(id, vi.start);
    });
    prevStartMap.current = newMap;
  });

  const setRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      itemRefs.current.set(id, el);
      el.style.transform = "translateY(0)";
    } else {
      itemRefs.current.delete(id);
    }
  }, []);

  return { setRef };
}
