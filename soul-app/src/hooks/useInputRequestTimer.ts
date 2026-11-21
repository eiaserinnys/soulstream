import { useState, useEffect } from 'react';
import { INPUT_REQUEST_TIMEOUT_SEC, inputRequestRemainingSec } from '../../../packages/soul-ui/src/lib/input-request-countdown';

export function useInputRequestTimer(
  receivedAt: number | undefined,
  timeoutSec: number = INPUT_REQUEST_TIMEOUT_SEC
): { remainingSec: number; isExpired: boolean } {
  const [remainingSec, setRemainingSec] = useState<number>(() =>
    inputRequestRemainingSec(receivedAt, timeoutSec)
  );

  useEffect(() => {
    if (!receivedAt) return;

    let intervalId: ReturnType<typeof setInterval>;
    const update = () => {
      const remaining = inputRequestRemainingSec(receivedAt, timeoutSec);
      setRemainingSec(remaining);
      if (remaining === 0) clearInterval(intervalId);
    };

    update();
    intervalId = setInterval(update, 1000);
    return () => clearInterval(intervalId);
  }, [receivedAt, timeoutSec]);

  return { remainingSec, isExpired: remainingSec <= 0 };
}
