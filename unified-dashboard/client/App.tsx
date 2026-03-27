/**
 * Unified Dashboard — Root App Component
 *
 * /api/config 응답(AppConfig)으로 single-node / orchestrator 모드를 분기한다.
 * 각 모드의 실제 레이아웃은 Phase 2-5에서 구현된다.
 */

import { useAppConfig } from "./config/AppConfigContext";
import { DashboardLayout } from "./DashboardLayout";
import { OrchestratorDashboardLayout } from "./OrchestratorDashboardLayout";

export function App() {
  const config = useAppConfig();

  if (config.mode === "orchestrator") {
    return <OrchestratorDashboardLayout />;
  }

  return <DashboardLayout />;
}
