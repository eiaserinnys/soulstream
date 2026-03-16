/**
 * useInputRequestTimer - AskUserQuestion 타임아웃 카운트다운 훅
 *
 * receivedAt(수신 시각)과 timeoutSec(타임아웃 초)를 기반으로
 * 남은 시간과 만료 여부를 1초 단위로 갱신합니다.
 */

import { useState, useEffect } from 'react';

export function useInputRequestTimer(
  receivedAt: number | undefined,
  timeoutSec: number = 300
): { remainingSec: number; isExpired: boolean } {
  const [remainingSec, setRemainingSec] = useState<number>(timeoutSec);

  useEffect(() => {
    if (!receivedAt) return;

    const update = () => {
      const elapsed = Math.floor((Date.now() - receivedAt) / 1000);
      const remaining = Math.max(0, timeoutSec - elapsed);
      setRemainingSec(remaining);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [receivedAt, timeoutSec]);

  return { remainingSec, isExpired: remainingSec <= 0 };
}
