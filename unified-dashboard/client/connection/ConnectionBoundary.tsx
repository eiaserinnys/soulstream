import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createConnectionMonitor,
  resynchronizeDashboard,
} from "./connection-monitor";
import { ConnectionDialog } from "./ConnectionDialog";
import { dashboardReloadCoordinator } from "../pwa/dashboard-reload";

export function ConnectionBoundary({ children }: { children: ReactNode }) {
  const [monitor] = useState(() =>
    createConnectionMonitor({
      buildId: __DASHBOARD_BUILD_ID__,
      fetch: (...args) => globalThis.fetch(...args),
      recover: resynchronizeDashboard,
      reload: () => dashboardReloadCoordinator().request(),
    }),
  );
  const snapshot = useSyncExternalStore(
    monitor.subscribe,
    monitor.snapshot,
    monitor.snapshot,
  );
  useLayoutEffect(() => {
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);
  return (
    <>
      {children}
      <ConnectionDialog snapshot={snapshot} />
    </>
  );
}
