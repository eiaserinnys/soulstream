import React from "react";
import { createRoot } from "react-dom/client";
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import "../../client/v3/v3-dashboard-styles";
import { LiquidGlassProvider } from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import { ChatView } from "@seosoyoung/soul-ui/components/chat/ChatView";
import { FolderPicker } from "../../client/v3/FolderPicker";
import { CardStatusPicker } from "../../client/v3/CardStatusPicker";
import { CardStatusChip } from "../../client/v3/CardActions";
import { CardRowView } from "../../client/v3/CardRow";
import { CardWorkspace } from "../../client/v3/CardWorkspace";

const scene = new URLSearchParams(location.search).get("scene") ?? "a";
const now = "2026-11-26T09:00:00Z";
const folders: CatalogFolder[] = [
  { id: "f-soulstream", name: "소울스트림", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "f-dashboard", name: "대시보드 표기 정리", parentFolderId: "f-soulstream", sortOrder: 1, status: "open", version: 1, archived: false },
  { id: "f-docs", name: "문서", parentFolderId: null, sortOrder: 2, status: "open", version: 1, archived: false },
];
const baseCard = (id: string, status: CardRow["status"], title: string): CardRow => ({
  id, folderId: "f-dashboard", title, attachments: [], request: "대시보드에서 카드 상태 표기가 처음 보는 사람의 기대와 맞는지 확인합니다.", brief: "",
  status, blockedKind: null, blockedDetail: null, positionKey: "a", queuePositionKey: null, assigneeKind: null, assigneeAgentId: null,
  assigneeUserId: null, assigneeSessionId: null, nodeId: null, modelPreset: null, version: 3, archived: false, createdAt: now, updatedAt: now,
} as CardRow);
const detailOf = (card: CardRow): CardDetail => ({ card, sessions: [], questions: [], comments: [], notes: [], nowHistory: [], reports: [] } as CardDetail);

useDashboardStore.setState({
  activeSessionKey: scene === "e" ? "failed-session" : null,
  activeSessionSummary: scene === "e" ? { agentSessionId: "failed-session", status: "error", eventCount: 0, backend: "codex" } as any : null,
  treeVersion: 1,
});

function Scene() {
  if (scene === "a") return <div className="v3-surface" style={{ maxWidth: 420, padding: 8 }}>
    <FolderPicker folders={folders} starredFolderIds={[]} disabledFolderIds={new Set()} selectedFolderId={null} pending={false} onSelect={() => undefined} />
  </div>;
  if (scene === "b") {
    const card = baseCard("c-verify", "awaiting_verification", "배포 뒤 확인 대기 카드");
    return <div style={{ padding: 24 }}><CardStatusPicker card={card} control={{ pending: false, load: async () => detailOf(card), change: async () => undefined }} onOpen={() => undefined} /></div>;
  }
  if (scene === "c") {
    const card = baseCard("c-run", "running", "상태 표기를 실행 중으로 맞춥니다");
    return <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <CardStatusChip card={card} />
      <CardRowView card={card} detail={detailOf(card)} onOpen={() => undefined} />
    </div>;
  }
  if (scene === "d") {
    const card = baseCard("c-empty", "todo", "아직 시작하지 않은 초안 카드");
    const mobile = window.innerWidth < 768;
    return <CardWorkspace cardId={card.id} sampleDetail={detailOf(card)} folders={folders} onClose={() => undefined} onOpenSession={() => undefined}
      mobileMode={mobile} mobileTab="chat" activeSession={undefined} chatInputDisabled historyEnabled={false} sessionStreamActive={false}
      sessionConnectionStatus="disconnected" reconnectSession={() => undefined} onAcknowledgedReview={() => undefined} />;
  }
  return <div style={{ height: 500 }}><ChatView /></div>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}><AuthProvider><LiquidGlassProvider>
    <main className="v3-shell v3-chat-surface min-h-screen text-foreground" data-testid="review-frame"><Scene /></main>
  </LiquidGlassProvider></AuthProvider></QueryClientProvider>,
);
