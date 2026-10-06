/**
 * Unified Dashboard — Root App Component
 *
 * Orchestrator dashboard entry point.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { redirectRetiredDashboardPathname } from "./dashboard-routes";
import { usePersistentSessionStartup } from './v3/use-persistent-session-startup';
import { V3Toast } from './v3/V3Toast';

const V3DashboardLayout = lazy(() =>
  import("./v3/V3DashboardLayout").then((mod) => ({
    default: mod.V3DashboardLayout,
  })),
);
const ComponentsReviewLayout = lazy(() =>
  import("./v3/ComponentsReviewLayout").then((mod) => ({
    default: mod.ComponentsReviewLayout,
  })),
);
const IosComponentsReviewPage = lazy(() =>
  import("./v3/IosComponentsReviewPage").then((mod) => ({
    default: mod.IosComponentsReviewPage,
  })),
);

const DialoguesReviewPage = lazy(() => import("./v3/DialoguesReviewPage").then(mod => ({default:mod.DialoguesReviewPage})));
const PersistentSessionScreen = lazy(() => import('./v3/PersistentSessionScreen').then(mod => ({ default: mod.PersistentSessionScreen })));

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const startupToast = usePersistentSessionStartup(pathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    redirectRetiredDashboardPathname(
      pathname,
      window.history,
      setPathname,
      window.location.href,
    );
  }, [pathname]);

  useEffect(() => {
    document.title = "Soulstream Dashboard";
  }, []);

  return (
    <><V3Toast message={startupToast}/><Suspense fallback={null}>
      {/^\/persistent(?:\/[^/]+)?\/?$/.test(pathname)
        ? <PersistentSessionScreen sessionId={pathname.split('/')[2] ? decodeURIComponent(pathname.split('/')[2]!) : undefined}/>
        : pathname === "/dialogues/ios" || pathname === "/dialogues/ios/"
        ? <IosComponentsReviewPage section="dialogues" />
        : pathname === "/components/ios" || pathname === "/components/ios/"
        ? <IosComponentsReviewPage />
        : pathname === "/dialogues" || pathname === "/dialogues/" ? <DialoguesReviewPage />
        : pathname === "/components" ? <ComponentsReviewLayout /> : <V3DashboardLayout />}
    </Suspense></>
  );
}
