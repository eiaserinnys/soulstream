import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenText, MessageSquare, Settings } from "lucide-react";

import {
  AskQuestionBanner,
  ChatView,
  ConnectionBadge,
  DashboardShell,
  MobileChatHeader,
  RightPanel,
  ThemeToggle,
  createSessionSummaryIndex,
  initTheme,
  projectLegacyFolder,
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
import { V2LegacyFolderSurface, type V2LegacyFolderSurfaceState } from "./V2LegacyFolderSurface";
import { V2MobileWorkspace } from "./V2MobileWorkspace";
import { V2PageSurface } from "./V2PageSurface";
import type { V2PageRouteController } from "./useV2PageRoute";
import { useV2PageWorkspace } from "./useV2PageWorkspace";
import { useV2LegacyBoardItems } from "./useV2LegacyBoardItems";

const V2_MOBILE_TABS = [
  {
    id: "feed",
    label: "Pages",
    icon: <BookOpenText data-testid="v2-pages-tab-icon" className="h-5 w-5" />,
  },
  { id: "chat", label: "Chat", icon: <MessageSquare className="h-5 w-5" /> },
  { id: "settings", label: "Settings", icon: <Settings className="h-5 w-5" /> },
] as const;

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
  const catalog = useDashboardStore((state) => state.catalog);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
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

  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    catalogLoad,
  } = useSessionListProvider({
    intervalMs: 5000,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionScope: "all",
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
  const sessionIndex = useMemo(() => createSessionSummaryIndex(sessions), [sessions]);
  const openSession = useCallback((session: typeof sessions[number]) => {
    setActiveSessionSummary(session);
    setActiveSession(session.agentSessionId);
    setActiveTab("chat");
  }, [setActiveSession, setActiveSessionSummary, setActiveTab]);
  const selectedLegacyFolderExists = workspace.selectedLegacyFolderId !== null
    && (catalog?.folders.some((folder) => folder.id === workspace.selectedLegacyFolderId) ?? false);
  const boardItemsLoad = useV2LegacyBoardItems({
    folderId: workspace.selectedLegacyFolderId,
    folders: catalog?.folders ?? [],
    enabled: catalogLoad.status === "ready" && selectedLegacyFolderExists,
  });

  const legacyState = useMemo<V2LegacyFolderSurfaceState>(() => {
    const folderId = workspace.selectedLegacyFolderId;
    if (!folderId) return { status: "loading", message: "Opening legacy folder…" };
    if (catalogLoad.status === "authentication") {
      return { status: "authentication", message: catalogLoad.message ?? "Sign in again to load legacy folders." };
    }
    if (catalogLoad.status === "forbidden") {
      return { status: "forbidden", message: catalogLoad.message ?? "You do not have access to this legacy folder." };
    }
    if (catalogLoad.status === "error") {
      return { status: "error", message: catalogLoad.message ?? "Legacy folders could not be loaded." };
    }
    if (!catalog || catalogLoad.status !== "ready" || (sessionsLoading && sessions.length === 0)) {
      return { status: "loading", message: "Loading legacy folder…" };
    }
    if (!selectedLegacyFolderExists) {
      return { status: "missing", message: "This legacy folder no longer exists or is unavailable." };
    }
    if (boardItemsLoad.status === "authentication") {
      return { status: "authentication", message: boardItemsLoad.message ?? "Sign in again to load legacy board items." };
    }
    if (boardItemsLoad.status === "forbidden") {
      return { status: "forbidden", message: boardItemsLoad.message ?? "You do not have access to these legacy board items." };
    }
    if (boardItemsLoad.status === "error") {
      return { status: "error", message: boardItemsLoad.message ?? "Legacy board items could not be loaded." };
    }
    if (boardItemsLoad.status !== "ready") {
      return { status: "loading", message: "Loading legacy board items…" };
    }
    if (sessionsError && sessions.length === 0) {
      return { status: "error", message: "Sessions could not be loaded for this legacy folder." };
    }
    const projection = projectLegacyFolder(catalog, sessions, folderId);
    if (projection.status === "missing") {
      return { status: "missing", message: "This legacy folder no longer exists or is unavailable." };
    }
    return { status: "ready", projection };
  }, [boardItemsLoad, catalog, catalogLoad, selectedLegacyFolderExists, sessions, sessionsError, sessionsLoading, workspace.selectedLegacyFolderId]);

  const openDaily = () => {
    setMobilePageOpenRequest((value) => value + 1);
    workspace.openDaily();
  };
  const openPage = (pageId: string) => {
    setMobilePageOpenRequest((value) => value + 1);
    workspace.openPage(pageId);
  };
  const openLegacyFolder = (folderId: string) => {
    setMobilePageOpenRequest((value) => value + 1);
    workspace.openLegacyFolder(folderId);
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
      legacyFolders={catalog?.folders ?? []}
      selectedLegacyFolderId={workspace.selectedLegacyFolderId}
      legacyStatus={catalogLoad}
      onOpenLegacyFolder={openLegacyFolder}
    />
  );
  const nativePageSurface = (
    <V2PageSurface
      state={workspace.pageState}
      onToggleStar={() => { void workspace.toggleCurrentPageStar(); }}
      lens={workspace.lens}
      onLensChange={workspace.setLens}
      sessionIndex={sessionIndex}
      onOpenSession={openSession}
    />
  );
  const pageSurface = workspace.selectedLegacyFolderId ? (
    <V2LegacyFolderSurface
      state={legacyState}
      lens={workspace.lens}
      onLensChange={workspace.setLens}
      onOpenFolder={openLegacyFolder}
      onOpenSession={openSession}
    />
  ) : nativePageSurface;
  const mobileWorkspace = (
    <V2MobileWorkspace
      pageId={workspace.selectedPageId ?? workspace.selectedLegacyFolderId}
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
      mobileTabs={V2_MOBILE_TABS}
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
