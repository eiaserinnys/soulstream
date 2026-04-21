import { useRef, useLayoutEffect, useCallback } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";

/**
 * id별 ref callback을 캐시하여 안정된 identity를 반환한다.
 * 훅 바깥에서도 테스트 가능하도록 분리한 순수 헬퍼.
 *
 * @param cache      id → callback 매핑 (호출 간 누적되는 Map)
 * @param itemRefs   id → 실제 DOM el 매핑 (호출 간 누적되는 Map)
 * @param id         세션 id
 * @returns          el을 받아 itemRefs에 등록/해제하는 callback.
 *                   동일 id에 대해서는 항상 같은 함수 인스턴스를 반환한다.
 */
export function getOrCreateRefCallback(
  cache: Map<string, (el: HTMLElement | null) => void>,
  itemRefs: Map<string, HTMLElement>,
  id: string,
): (el: HTMLElement | null) => void {
  let cb = cache.get(id);
  if (!cb) {
    cb = (el: HTMLElement | null) => {
      if (el) {
        itemRefs.set(id, el);
      } else {
        itemRefs.delete(id);
      }
    };
    cache.set(id, cb);
  }
  return cb;
}

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
 * getItemRef(id)가 반환하는 ref callback으로 inner div를 등록하면,
 * 다음 렌더 시 vi.start 변화량(delta)을 inner div에 Invert 적용 후
 * double-rAF로 Play한다. id별 callback identity를 캐시로 안정화하여
 * React 19 ref cleanup에 의한 detach/attach 사이클을 방지한다.
 */
export function useFlipAnimation<T extends { agentSessionId: string }>(
  items: T[],
  virtualItems: VirtualItem[],
  duration = 200
): { getItemRef: (id: string) => (el: HTMLElement | null) => void } {
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevStartMap = useRef<Map<string, number>>(new Map());
  // 뷰포트 첫 노출 1회 한정 enter 재생을 위한 seen 집합 (훅 인스턴스 캡슐화).
  // overscan 밖으로 나갔다가 돌아와도 enter가 다시 재생되지 않는다.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // ref callback 안정화: id별로 동일한 callback 인스턴스를 반환
  const refCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());

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

        if (prevStart === undefined) {
          // 새 아이템: seen에 없을 때만 enter 재생, 재생 여부와 무관하게 seen에 기록
          if (seenIdsRef.current.has(id)) {
            seenIdsRef.current.add(id);
            return;
          }
          seenIdsRef.current.add(id);

          // Enter: opacity 0 → 1, translateY 8 → 0
          el.style.transition = "none";
          el.style.opacity = "0";
          el.style.transform = "translateY(8px)";

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transition = `opacity ${duration}ms ease-out, transform ${duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
            });
          });
          return;
        }

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
    } else {
      // reduced motion: enter/reorder 모두 스킵, seen 집합만 갱신한다.
      virtualItems.forEach((vi) => {
        const id = items[vi.index]?.agentSessionId;
        if (id) seenIdsRef.current.add(id);
      });
    }

    // 스냅샷 갱신 (reduced motion이어도 항상 갱신)
    const newMap = new Map<string, number>();
    virtualItems.forEach((vi) => {
      const id = items[vi.index]?.agentSessionId;
      if (id) newMap.set(id, vi.start);
    });
    prevStartMap.current = newMap;

    // 캐시 정리: items(전체 세션 목록)에서 사라진 id만 제거한다.
    // virtualItems는 overscan 기반 일부만 담으므로 기준으로 삼으면
    // 스크롤로 overscan 이탈 시 seenIdsRef가 제거되어 복귀할 때 enter가 재재생된다.
    const allIds = new Set<string>();
    items.forEach((item) => {
      if (item?.agentSessionId) allIds.add(item.agentSessionId);
    });
    for (const id of Array.from(refCallbacksRef.current.keys())) {
      if (!allIds.has(id)) {
        refCallbacksRef.current.delete(id);
        itemRefs.current.delete(id);
        seenIdsRef.current.delete(id);
      }
    }
  });

  const getItemRef = useCallback(
    (id: string) => getOrCreateRefCallback(refCallbacksRef.current, itemRefs.current, id),
    [],
  );

  return { getItemRef };
}
