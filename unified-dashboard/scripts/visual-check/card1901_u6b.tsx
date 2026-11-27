import React from "react";
import { createRoot } from "react-dom/client";
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import "../../client/v3/v3-dashboard-styles";
import { LiquidGlassProvider } from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";
import { buildUsageStatsOverview, USAGE_STATS_FIXTURE_ANCHOR } from "@seosoyoung/soul-ui/lib/usage-stats-fixtures";
import { V3SessionPanel } from "../../client/v3/V3SessionPanel";
import { SessionPanelHeader } from "../../client/v3/WorkspacePanelHeaders";
import { V3Navigation } from "../../client/v3/V3Navigation";
import { MobileProjectList } from "../../client/v3/MobileProjectList";
import { MobilePlannerTabs } from "../../client/v3/MobilePlannerTabs";
import { UsageStatsTab } from "../../client/components/usage-stats/UsageStatsTab";

const scene = new URLSearchParams(location.search).get("scene") ?? "a";
const noop = () => undefined;
const asyncNoop = async () => undefined;
const folders: CatalogFolder[] = [
  { id: "f-soulstream", name: "소울스트림", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "f-dashboard", name: "대시보드 표기 정리", parentFolderId: "f-soulstream", sortOrder: 1, status: "open", version: 1, archived: false },
  { id: "f-docs", name: "문서", parentFolderId: null, sortOrder: 2, status: "open", version: 1, archived: false },
];
const session = (id: string, sessionType: "claude" | "llm", displayName: string): SessionSummary => ({
  agentSessionId: id, status: "completed", reviewState: "needs_review", sessionType, eventCount: 12, displayName,
  agentId: sessionType === "llm" ? "translator" : "utonium", agentName: sessionType === "llm" ? "번역기" : "서소영",
  nodeId: "eiaserinnys", folderId: "f-dashboard", cardId: "card-running",
  createdAt: "2026-11-26T09:00:00Z", updatedAt: "2026-11-26T09:20:00Z",
  lastMessage: { type: "assistant_message", preview: sessionType === "llm" ? "번역을 마쳤습니다." : "이번 턴 작업을 마쳤습니다.", timestamp: "2026-11-26T09:20:00Z" },
} as SessionSummary);
const agentSession = session("s-agent", "claude", "상태 표기 수정");
const llmSession = session("s-llm", "llm", "문구 번역");

const usageRequest: typeof fetch = async () => {
  Date.now = () => Date.parse("2026-10-18T03:00:00.000Z");
  const overview = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });
  return new Response(JSON.stringify(overview), { status: 200, headers: { "content-type": "application/json" } });
};

function navigation(list: CatalogFolder[]) {
  return <div className="v3-navigation-review" style={{ width: 320, height: 560 }}>
    <V3Navigation
      dates={[{ date: "2026-11-26", label: "오늘" }]} selectedDate="2026-11-26" folders={list} selectedFolderId={null}
      starredFolders={[]} starredFoldersHasMore={false} starredFoldersLoading={false}
      todayFolderIds={new Set()} completedFolderIds={new Set()}
      onLoadMoreStarredFolders={noop} onReorderStarredFolders={asyncNoop} onSelectDate={noop} onSelectFolder={noop}
      onSelectStarredFolder={noop} onCompleteFolder={asyncNoop} onToggleFolderToday={asyncNoop} onMoveFolderToParent={noop}
      onCreateProject={async (title, parentFolderId) => ({ status: "open", version: 1, archived: false, id: "created", name: title, sortOrder: 0, parentFolderId, projectPageId: "created" } as CatalogFolder)}
      onRenameProject={asyncNoop} onDeleteProject={asyncNoop} onReorderProjects={asyncNoop} projectHasContents={async () => false}
    />
  </div>;
}

function Scene() {
  if (scene === "a") return <div style={{ padding: 16, maxWidth: 420, height: 640 }}>
    <V3SessionPanel sessions={[agentSession, llmSession]} folders={folders}
      nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["eiaserinnys"]) }} activeSessionId={null}
      onOpenSession={noop} onAcknowledged={noop} />
  </div>;
  if (scene === "b") return <div style={{ padding: 16, display: "grid", gap: 16 }} className="v3-surface">
    {[agentSession, llmSession].map(item => <div key={item.agentSessionId} data-testid={`header-${item.sessionType}`}>
      <SessionPanelHeader session={item} streamActive={false} connectionStatus={"disconnected" as never} reconnect={noop} />
    </div>)}
  </div>;
  if (scene === "c") {
    if (window.innerWidth < 768) return <div style={{ display: "grid", gap: 16, padding: 8 }}>
      <MobileProjectList folders={folders} onSelect={noop} />
      <MobilePlannerTabs activeTab="projects" onSelect={noop} />
    </div>;
    return <div style={{ display: "flex", gap: 24, padding: 16 }}>{navigation(folders)}{navigation([])}</div>;
  }
  return <div style={{ padding: 16, maxWidth: 960 }}><UsageStatsTab request={usageRequest} /></div>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}><AuthProvider><LiquidGlassProvider>
    <main className="v3-shell v3-chat-surface min-h-screen text-foreground" data-testid="review-frame"><Scene /></main>
  </LiquidGlassProvider></AuthProvider></QueryClientProvider>,
);
