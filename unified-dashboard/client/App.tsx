/**
 * Unified Dashboard — Root App Component
 *
 * /api/config 응답(AppConfig)으로 single-node / orchestrator 모드를 분기한다.
 * 각 모드의 실제 레이아웃은 Phase 2-5에서 구현된다.
 */

import { useAppConfig } from "./config/AppConfigContext";

export function App() {
  const config = useAppConfig();

  if (config.mode === "orchestrator") {
    // Phase 5에서 OrchestratorLayout으로 교체
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Orchestrator mode — layout coming in Phase 5
      </div>
    );
  }

  // single-node mode — Phase 2에서 DashboardLayout으로 교체
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
      Single-node mode — layout coming in Phase 2
    </div>
  );
}
