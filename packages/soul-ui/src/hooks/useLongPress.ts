/**
 * useLongPress
 *
 * 포인터를 일정 시간(`delay`) 누르면 `onLongPress`를 발화하고,
 * 그동안의 진행률(0~100)을 `onProgress`에 보고한다.
 * 짧은 탭(릴리즈 < delay)이나 cancel/leave에서는 onLongPress를 발화하지 않는다.
 *
 * 시그니처:
 *   useLongPress(onLongPress, { delay, onProgress?, disabled? })
 *     → { onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, fired }
 *
 * 호출자(SuggestionChip)는 fired 또는 별도 ref로 click 이벤트를 가드해야 한다 —
 * 본 훅은 click 합성을 직접 차단하지 않는다 (관심사 분리).
 *
 * 진행률 계산은 순수 함수 `computeLongPressProgress`로 분리되어 단위 테스트된다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

const PROGRESS_INTERVAL_MS = 60;

export interface UseLongPressOptions {
  /** 롱프레스로 인정되는 누적 시간 (ms) */
  delay: number;
  /** 진행률 콜백 (0~100). 미제공 시 호출 없음 */
  onProgress?: (progressPct: number) => void;
  /** true이면 모든 핸들러 no-op */
  disabled?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
}

/**
 * 누적 시간(ms)으로부터 진행률(0~100)을 계산한다.
 * delay <= 0이면 항상 100을 반환 (즉시 fire 의도).
 */
export function computeLongPressProgress(elapsedMs: number, delayMs: number): number {
  if (delayMs <= 0) return 100;
  const pct = Math.floor((elapsedMs / delayMs) * 100);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

export function useLongPress(
  onLongPress: () => void,
  options: UseLongPressOptions,
): LongPressHandlers & { fired: boolean } {
  const { delay, onProgress, disabled = false } = options;

  const [fired, setFired] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // 최신 콜백 참조 (effect 재실행 없이 호출)
  const onLongPressRef = useRef(onLongPress);
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const cleanup = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    startedAtRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cleanup();
    onProgressRef.current?.(0);
    setFired(false);
  }, [cleanup]);

  // 언마운트 시 interval 누수 방지
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  const onPointerDown = useCallback(
    (_e: React.PointerEvent) => {
      if (disabled) return;
      // 이전 세션 정리 (멀티터치/재누름)
      cleanup();
      setFired(false);
      startedAtRef.current = Date.now();
      onProgressRef.current?.(0);
      intervalRef.current = setInterval(() => {
        const startedAt = startedAtRef.current;
        if (startedAt === null) return;
        const elapsed = Date.now() - startedAt;
        const pct = computeLongPressProgress(elapsed, delay);
        onProgressRef.current?.(pct);
        if (elapsed >= delay) {
          if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          startedAtRef.current = null;
          setFired(true);
          onLongPressRef.current();
        }
      }, PROGRESS_INTERVAL_MS);
    },
    [cleanup, delay, disabled],
  );

  const onPointerUp = useCallback(
    (_e: React.PointerEvent) => {
      if (disabled) return;
      reset();
    },
    [disabled, reset],
  );

  const onPointerCancel = useCallback(
    (_e: React.PointerEvent) => {
      if (disabled) return;
      reset();
    },
    [disabled, reset],
  );

  const onPointerLeave = useCallback(
    (_e: React.PointerEvent) => {
      if (disabled) return;
      reset();
    },
    [disabled, reset],
  );

  return { onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, fired };
}
