/**
 * useDashboardConfig - 대시보드 프로필 설정 로딩
 *
 * 서버의 /api/dashboard/config에서 사용자/어시스턴트 이름과 프로필 이미지 정보를 가져옵니다.
 */

import { useEffect } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { DashboardConfig } from "../stores/dashboard-store";

const DEFAULT_CONFIG: DashboardConfig = {
  user: { name: "USER", id: "", hasPortrait: false },
  agents: [],
};

export function useDashboardConfig() {
  const setDashboardConfig = useDashboardStore((s) => s.setDashboardConfig);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/dashboard/config")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: DashboardConfig) => {
        if (!cancelled) setDashboardConfig(data);
      })
      .catch(() => {
        if (!cancelled) setDashboardConfig(DEFAULT_CONFIG);
      });

    return () => { cancelled = true; };
  }, [setDashboardConfig]);
}
