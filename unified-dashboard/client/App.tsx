/**
 * Unified Dashboard — Root App Component
 *
 * /api/config 응답(AppConfig)으로 single-node / orchestrator 모드를 분기한다.
 * 각 모드의 실제 레이아웃은 Phase 2-5에서 구현된다.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { useAppConfig } from "./config/AppConfigContext";
import {
  redirectRetiredDashboardPathname,
  resolveOrchestratorDashboardVersion,
} from "./dashboard-routes";

const DashboardLayout = lazy(() =>
  import("./DashboardLayout").then((mod) => ({ default: mod.DashboardLayout })),
);
const OrchestratorDashboardLayout = lazy(() =>
  import("./OrchestratorDashboardLayout").then((mod) => ({
    default: mod.OrchestratorDashboardLayout,
  })),
);
const V3DashboardLayout = lazy(() =>
  import("./v3/V3DashboardLayout").then((mod) => ({
    default: mod.V3DashboardLayout,
  })),
);

export function App() {
  const config = useAppConfig();
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    redirectRetiredDashboardPathname(pathname, window.history, setPathname);
  }, [pathname]);

  useEffect(() => {
    if (config.mode === "orchestrator") {
      document.title = "Soulstream Dashboard";
    } else {
      document.title = config.nodeId
        ? `Soul Dashboard (${config.nodeId})`
        : "Soul Dashboard";
    }
  }, [config.mode, config.nodeId]);

  if (config.mode === "orchestrator") {
    if (resolveOrchestratorDashboardVersion(pathname) === "v1") {
      return (
        <Suspense fallback={null}>
          <OrchestratorDashboardLayout />
        </Suspense>
      );
    }
    return (
      <Suspense fallback={null}>
        <V3DashboardLayout />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <DashboardLayout />
    </Suspense>
  );
}
