import type { SessionSummary } from "@seosoyoung/soul-ui";

import { singleLinePreview } from "./session-preview";
import type { RunTreeNode } from "./task-workspace-model";
import type { PageSessionDefaults } from "./task-workspace-api";

const SUCCESSION_SESSION_LABEL_LENGTH = 80;

export interface SuccessionSessionOption {
  sessionId: string;
  label: string;
  runNumber: number | null;
}

export interface SessionPageAnchor {
  pageId: string;
  blockId: string;
  expectedVersion: number;
}

export function buildSuccessionCreateOptions({
  includePageContext,
  inheritSummary,
  pageAnchor,
  predecessorSessionId,
}: {
  includePageContext: boolean;
  inheritSummary: boolean;
  pageAnchor: SessionPageAnchor | null;
  predecessorSessionId: string | null;
}): { pageAnchor?: SessionPageAnchor; predecessorSessionId?: string } {
  return {
    ...(includePageContext && pageAnchor ? { pageAnchor } : {}),
    ...(inheritSummary && predecessorSessionId ? { predecessorSessionId } : {}),
  };
}

export function resolveRunAssignmentDefaults({
  pageDefaults,
  currentSession,
}: {
  pageDefaults: PageSessionDefaults | null;
  currentSession: SessionSummary | null;
}): { agentId: string | null; nodeId: string | null; source: "page-defaults" | "current-session" | "none" } {
  const agentId = pageDefaults?.agentId ?? currentSession?.agentId ?? null;
  const nodeId = pageDefaults?.nodeId ?? currentSession?.nodeId ?? null;
  const source = pageDefaults && (pageDefaults.agentId || pageDefaults.nodeId)
    ? "page-defaults"
    : currentSession && (currentSession.agentId || currentSession.nodeId)
      ? "current-session"
      : "none";
  return { agentId, nodeId, source };
}

export function latestTaskRun(
  sessionIds: readonly string[],
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  const allowed = new Set(sessionIds);
  return sessions
    .filter((session) => allowed.has(session.agentSessionId))
    .sort((left, right) => sessionTime(right) - sessionTime(left))[0] ?? null;
}

export function buildSuccessionSessionOptions(
  tree: readonly RunTreeNode[],
): SuccessionSessionOption[] {
  const options: SuccessionSessionOption[] = [];
  const visit = (node: RunTreeNode) => {
    if (node.loadState === "ready") {
      options.push({
        sessionId: node.session.agentSessionId,
        label: singleLinePreview(
          node.session.displayName,
          SUCCESSION_SESSION_LABEL_LENGTH,
        ) ?? singleLinePreview(
          node.session.lastMessage?.preview,
          SUCCESSION_SESSION_LABEL_LENGTH,
        ) ?? "제목 없는 세션",
        runNumber: node.runNumber,
      });
    }
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return options;
}

function sessionTime(session: SessionSummary): number {
  const parsed = Date.parse(session.createdAt ?? session.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
