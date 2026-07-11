import { useEffect, useMemo, useState } from "react";

import {
  AskQuestionBanner,
  ChatView,
  ConnectionBadge,
  DashboardShell,
  MobileChatHeader,
  RightPanel,
  ThemeToggle,
  initTheme,
  useAuth,
  useDashboardConfig,
  useDashboardStore,
  useNotification,
  useReadPositionSync,
  useServerStatus,
  useSessionListProvider,
  useSessionProvider,
  useUserPreferencesSync,
} from "@seosoyoung/soul-ui";
import {
  createPageApiClient,
  type PageApiClient,
  type PageYjsClient,
} from "@seosoyoung/soul-ui/page";

import { ConfigButton } from "../components/ConfigButton";
import { ConfigModal } from "../components/ConfigModal";
import { SearchModal } from "../components/SearchModal";
import { useNodes } from "../hooks/useNodes";
import { resolveActiveSessionSummary } from "../lib/active-session-summary";
import { orchestratorSessionProvider } from "../providers";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { V2LeftNavigation } from "./V2LeftNavigation";
import { V2MobileWorkspace } from "./V2MobileWorkspace";
import { V2PageSurface } from "./V2PageSurface";
import type { V2PageRouteController } from "./useV2PageRoute";
import { useV2PageWorkspace } from "./useV2PageWorkspace";

export interface V2DashboardLayoutProps {
  apiClient?: PageApiClient;
  routeController?: V2PageRouteController;
  createPageClient?: (pageId: string) => PageYjsClient;
}

export function V2DashboardLayout({
  apiClient: injectedApiClient,
  routeController,
  createPageClient,
}: V2DashboardLayoutProps = {}) {
  const apiClient = useMemo(
    () => injectedApiClient ?? createPageApiClient(),
    [injectedApiClient],
  );
  const workspace = useV2PageWorkspace({ apiClient, routeController, createPageClient });
  const [mobilePageOpenRequest, setMobilePageOpenRequest] = useState(0);
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const nodes = useOrchestratorStore((state) => state.nodes);
  const connectionStatus = useOrchestratorStore((state) => state.connectionStatus);

  useEffect(() => { initTheme(); }, []);
  const { user } = useAuth();
  useUserPreferencesSync(user?.email ?? null);
  useReadPositionSync();
  useNotification();
  useDashboardConfig();
  const { isDraining } = useServerStatus();
  useNodes();

  const { sessions } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider: () => orchestratorSessionProvider,
  });
  const { status: sessionStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
  });
  const activeSession = useMemo(
    () => resolveActiveSessionSummary(activeSessionKey, activeSessionSummary, sessions),
    [activeSessionKey, activeSessionSummary, sessions],
  );
  const chatInputDisabled = useMemo(() => {
    if (!activeSessionKey) return false;
    if (!activeSession?.nodeId) return true;
    const node = nodes.get(activeSession.nodeId);
    return !node || node.status === "disconnected";
  }, [activeSession, activeSessionKey, nodes]);
  const fileUploadUrl = useMemo(() => {
    if (!activeSession?.nodeId || chatInputDisabled) return undefined;
    return `/api/attachments/sessions?nodeId=${encodeURIComponent(activeSession.nodeId)}`;
  }, [activeSession, chatInputDisabled]);

  const openDaily = () => {
    setMobilePageOpenRequest((value) => value + 1);
    workspace.openDaily();
  };
  const openPage = (pageId: string) => {
    setMobilePageOpenRequest((value) => value + 1);
    workspace.openPage(pageId);
  };
  const navigation = (
    <V2LeftNavigation
      selectedPageId={workspace.selectedPageId}
      starredPages={workspace.starredPages}
      loading={workspace.starredLoading}
      error={workspace.starredError}
      onOpenDaily={openDaily}
      onOpenPage={openPage}
      onUnstarPage={(page) => { void workspace.unstarPage(page); }}
    />
  );
  const pageSurface = (
    <V2PageSurface
      state={workspace.pageState}
      onToggleStar={() => { void workspace.toggleCurrentPageStar(); }}
    />
  );
  const mobileWorkspace = (
    <V2MobileWorkspace
      pageId={workspace.selectedPageId}
      pageOpenRequest={mobilePageOpenRequest}
      navigation={navigation}
      pageSurface={pageSurface}
    />
  );

  return (
    <DashboardShell
      title="Soulstream Pages"
      leftPanel={navigation}
      centerPanel={pageSurface}
      rightPanel={(
        <div data-v2-pane="right" className="h-full min-h-0">
          <RightPanel chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} />
        </div>
      )}
      connectionStatus={connectionStatus ?? sessionStatus}
      onSearchClick={() => setSearchOpen(true)}
      bannerPlacement="viewport-top"
      banner={isDraining ? (
        <div role="status" className="shrink-0 bg-warning px-4 py-1.5 text-center text-sm font-medium text-warning-foreground">
          The server is restarting. Sessions will resume automatically.
        </div>
      ) : undefined}
      headerRight={(
        <>
          <ConfigButton variant="chrome" onClick={() => setConfigOpen(true)} />
          <ThemeToggle variant="chrome" />
        </>
      )}
      mobileSessionsView={mobileWorkspace}
      mobileFolderContents={mobileWorkspace}
      mobileRunbooksView={mobileWorkspace}
      mobileChatHeader={(onBack) => <MobileChatHeader onBack={onBack} />}
      mobileChatView={(
        <ChatView
          chatInputDisabled={chatInputDisabled}
          fileUploadUrl={fileUploadUrl}
          showHeader={false}
        />
      )}
      mobileSettingsContent={(
        <div className="space-y-4 p-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm">Theme</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Connection</span>
            <ConnectionBadge status={sessionStatus} />
          </div>
        </div>
      )}
      modals={(
        <>
          <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
          <SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} />
          <AskQuestionBanner />
        </>
      )}
    />
  );
}
