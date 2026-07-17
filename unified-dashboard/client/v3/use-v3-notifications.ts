import { useCallback, useEffect, useRef, useState } from "react";

import { reportV3WriteFailure } from "./v3-dashboard-utils";

export function useV3Notifications(refreshAuthStatus: () => Promise<void>) {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const notifyWriteFailure = useCallback((action: string, error: unknown) => {
    return reportV3WriteFailure({
      action,
      error,
      notify,
      refreshAuthStatus: () => {
        void refreshAuthStatus().catch((refreshError: unknown) => {
          console.error("[v3/auth] 인증 상태 갱신 실패", refreshError);
        });
      },
    });
  }, [notify, refreshAuthStatus]);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  return { toast, notify, notifyWriteFailure };
}
