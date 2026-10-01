/**
 * useInputRequestTimer — AskUserQuestion 타임아웃 카운트다운 훅
 *
 * receivedAt(수신 시각 ms)과 timeoutSec(타임아웃 초)를 기반으로
 * 남은 시간과 만료 여부를 1초 단위로 갱신한다.
 *
 * web soul-ui의 동일 훅을 그대로 포팅. RN도 useState/useEffect/setInterval 동일.
 */

import { useState, useEffect } from 'react';

const calcRemaining = (at: number | undefined, timeoutSec: number): number => {
  if (!at) return timeoutSec;
  return Math.max(0, timeoutSec - Math.floor((Date.now() - at) / 1000));
};

export function useInputRequestTimer(
  receivedAt: number | undefined,
  timeoutSec: number = 300
): { remainingSec: number; isExpired: boolean } {
  const [remainingSec, setRemainingSec] = useState<number>(() =>
    calcRemaining(receivedAt, timeoutSec)
  );

  useEffect(() => {
    if (!receivedAt) return;

    let intervalId: ReturnType<typeof setInterval>;
    const update = () => {
      const remaining = Math.max(
        0,
        timeoutSec - Math.floor((Date.now() - receivedAt) / 1000)
      );
      setRemainingSec(remaining);
      if (remaining === 0) clearInterval(intervalId);
    };

    update();
    intervalId = setInterval(update, 1000);
    return () => clearInterval(intervalId);
  }, [receivedAt, timeoutSec]);

  return { remainingSec, isExpired: remainingSec <= 0 };
}
