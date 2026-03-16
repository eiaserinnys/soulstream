/**
 * useServerStatus - Soul Server 드레이닝 상태 폴링 훅
 *
 * /api/status를 주기적으로 폴링하여 서버가 재시작 중인지(is_draining) 감지한다.
 * 502/네트워크 오류 시에는 is_draining=true로 간주하여 배너를 유지한다.
 */

import { useState, useEffect } from "react";

interface ServerStatus {
  isDraining: boolean;
}

export function useServerStatus(intervalMs = 3000): ServerStatus {
  const [isDraining, setIsDraining] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/status");
        if (cancelled) return;
        if (!res.ok) {
          // 502 등 오류 응답 → draining으로 간주
          setIsDraining(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setIsDraining(data.is_draining ?? false);
        }
      } catch {
        // 네트워크 오류 → draining으로 간주
        if (!cancelled) setIsDraining(true);
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { isDraining };
}
