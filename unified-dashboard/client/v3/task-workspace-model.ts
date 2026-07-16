import type { SessionSummary } from "@seosoyoung/soul-ui";
import type {
  BlockDto,
  PageDto,
  PageStructureOperation,
} from "@seosoyoung/soul-ui/page";

import {
  markdownToPageBlocks,
  pageToMarkdown,
} from "../../../packages/page-model/src/markdown";

export const MIN_WORKSPACE_SPLIT = 25;
export const MAX_WORKSPACE_SPLIT = 75;
export const DEFAULT_WORKSPACE_SPLIT = 60;
export const WORKSPACE_SPLIT_STEP = 2;

export interface RunTreeNode {
  session: SessionSummary;
  runNumber: number | null;
  loadState: RunSessionLoadState;
  children: RunTreeNode[];
}

export type RunSessionLoadState = "ready" | "loading" | "failed";

export interface RunSessionResolution {
  sessions: SessionSummary[];
  loadStateById: ReadonlyMap<string, RunSessionLoadState>;
}

export interface TaskSessionReconciliation {
  sessionIds: string[];
  sessions: SessionSummary[];
  optimisticOnlyCount: number;
}

export interface RunSessionActivationPort {
  setActiveSessionSummary(session: SessionSummary): void;
  setActiveSession(sessionId: string): void;
  setActiveTab(tab: "chat"): void;
}

export interface WorkspaceVisibility {
  workspaceOpen: boolean;
  chatOpen: boolean;
}

export type WorkspaceInspectorKind = "document" | "chat" | "empty";

export interface DescriptionMutation {
  operations: PageStructureOperation[];
  preservedBlockIds: string[];
}

export function clampWorkspaceSplit(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_WORKSPACE_SPLIT;
  return Math.max(MIN_WORKSPACE_SPLIT, Math.min(MAX_WORKSPACE_SPLIT, percent));
}

export function workspaceSplitForKey(current: number, key: string): number | null {
  if (key === "Home") return DEFAULT_WORKSPACE_SPLIT;
  if (key === "ArrowLeft") return clampWorkspaceSplit(current - WORKSPACE_SPLIT_STEP);
  if (key === "ArrowRight") return clampWorkspaceSplit(current + WORKSPACE_SPLIT_STEP);
  return null;
}

export function reduceWorkspaceEscape(state: WorkspaceVisibility): WorkspaceVisibility & { handled: boolean } {
  if (state.chatOpen || state.workspaceOpen) {
    return { workspaceOpen: false, chatOpen: false, handled: true };
  }
  return { ...state, handled: false };
}

export function workspaceInspectorKind(
  activeBoardDocumentId: string | null,
  activeSessionKey: string | null,
): WorkspaceInspectorKind {
  if (activeBoardDocumentId) return "document";
  return activeSessionKey ? "chat" : "empty";
}

export function buildRunTree(
  containerSessionIds: readonly string[],
  sessions: readonly SessionSummary[],
  loadStateById?: ReadonlyMap<string, RunSessionLoadState>,
): RunTreeNode[] {
  const byId = new Map(sessions.map((session) => [session.agentSessionId, session]));
  const rootIds = new Set(containerSessionIds);
  const roots = containerSessionIds.flatMap((sessionId) => {
    const session = byId.get(sessionId);
    if (session) return [{ session, loadState: "ready" as const }];
    const loadState = loadStateById?.get(sessionId);
    return loadState ? [{ session: missingSession(sessionId), loadState }] : [];
  });
  const chronologicalRoots = roots.every((root) => root.loadState === "ready")
    ? [...roots].sort((left, right) => compareSessionTime(left.session, right.session))
    : roots;
  const runNumberById = new Map(
    chronologicalRoots.map(({ session }, index) => [session.agentSessionId, index + 1]),
  );
  const childrenByParent = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const parentId = session.callerSessionId;
    if (!parentId || rootIds.has(session.agentSessionId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareSessionTimeDescending);

  const project = (
    session: SessionSummary,
    runNumber: number | null,
    ancestors: ReadonlySet<string>,
    loadState: RunSessionLoadState = "ready",
  ): RunTreeNode => {
    const nextAncestors = new Set(ancestors).add(session.agentSessionId);
    const children = (childrenByParent.get(session.agentSessionId) ?? [])
      .filter((child) => !nextAncestors.has(child.agentSessionId))
      .map((child) => project(child, null, nextAncestors));
    return { session, runNumber, loadState, children };
  };

  return [...chronologicalRoots]
    .reverse()
    .map(({ session, loadState }) => project(
      session,
      runNumberById.get(session.agentSessionId) ?? null,
      new Set(),
      loadState,
    ));
}

export function resolveRunSessions({
  sessionIds,
  catalogSessions,
  targetedSessions,
  targetedLoading,
}: {
  sessionIds: readonly string[];
  catalogSessions: readonly SessionSummary[];
  targetedSessions: readonly SessionSummary[];
  targetedLoading: boolean;
}): RunSessionResolution {
  const byId = new Map(catalogSessions.map((session) => [session.agentSessionId, session]));
  for (const session of targetedSessions) byId.set(session.agentSessionId, session);
  const loadStateById = new Map<string, RunSessionLoadState>();
  for (const sessionId of sessionIds) {
    loadStateById.set(sessionId, byId.has(sessionId)
      ? "ready"
      : targetedLoading ? "loading" : "failed");
  }
  return { sessions: [...byId.values()], loadStateById };
}

export function reconcileTaskSessions({
  serverSessionIds,
  serverSessions,
  optimisticSessions,
}: {
  serverSessionIds: readonly string[];
  serverSessions: readonly SessionSummary[];
  optimisticSessions: readonly SessionSummary[];
}): TaskSessionReconciliation {
  const serverById = new Map<string, SessionSummary>();
  for (const session of serverSessions) {
    if (!serverById.has(session.agentSessionId)) {
      serverById.set(session.agentSessionId, session);
    }
  }
  const optimisticById = new Map<string, SessionSummary>();
  for (const session of optimisticSessions) {
    if (!optimisticById.has(session.agentSessionId)) {
      optimisticById.set(session.agentSessionId, session);
    }
  }
  const optimisticOnly = [...optimisticById.values()].filter(
    (session) => !serverById.has(session.agentSessionId),
  );
  return {
    sessionIds: [...new Set([...serverSessionIds, ...optimisticById.keys()])],
    sessions: [...serverById.values(), ...optimisticOnly],
    optimisticOnlyCount: optimisticOnly.length,
  };
}

export function activateRunSession(
  session: SessionSummary,
  port: RunSessionActivationPort,
): void {
  port.setActiveSessionSummary(session);
  port.setActiveSession(session.agentSessionId);
  port.setActiveTab("chat");
}

export function descriptionMarkdown(page: PageDto, blocks: readonly BlockDto[]): string {
  const editable = editableDescriptionBlocks(blocks);
  if (editable.length === 0) return "";
  const normalized = editable.map((block) => ({
    ...block,
    parent_id: editable.some((candidate) => candidate.id === block.parent_id)
      ? block.parent_id
      : null,
  }));
  const rendered = pageToMarkdown(page, normalized);
  return rendered.split("\n").slice(2).join("\n").trim();
}

export function buildDescriptionMutation({
  page,
  blocks,
  markdown,
  createTempId,
}: {
  page: PageDto;
  blocks: readonly BlockDto[];
  markdown: string;
  createTempId(): string;
}): DescriptionMutation {
  const editable = editableDescriptionBlocks(blocks);
  const editableIds = new Set(editable.map((block) => block.id));
  const editableRoots = editable.filter((block) => !block.parent_id || !editableIds.has(block.parent_id));
  const preserved = blocks.filter((block) => !editableIds.has(block.id));
  const operations: PageStructureOperation[] = editableRoots.map((block) => ({
    op: "delete_block_subtree",
    block_id: block.id,
  }));
  const source = markdown.trim() ? `# ${page.title}\n\n${markdown.trim()}` : `# ${page.title}`;
  const parsed = markdownToPageBlocks(source, { title: page.title, createId: createTempId });
  const lastPreservedRoot = [...preserved].reverse().find((block) => block.parent_id === null)?.id ?? null;
  const lastSibling = new Map<string | null, { kind: "block" | "temp"; id: string }>();
  if (lastPreservedRoot) lastSibling.set(null, { kind: "block", id: lastPreservedRoot });

  for (const block of parsed) {
    const parentTempId = block.parent_id;
    const previous = lastSibling.get(parentTempId);
    operations.push({
      op: "create_block",
      temp_id: block.id,
      parent_id: null,
      ...(parentTempId ? { parent_temp_id: parentTempId } : {}),
      after_block_id: previous?.kind === "block" ? previous.id : null,
      ...(previous?.kind === "temp" ? { after_temp_id: previous.id } : {}),
      block_type: block.type,
      text: block.text,
      properties: block.properties,
      collapsed: block.collapsed,
    });
    lastSibling.set(parentTempId, { kind: "temp", id: block.id });
  }

  return {
    operations,
    preservedBlockIds: preserved.map((block) => block.id),
  };
}

export function isRunResumable(session: SessionSummary): boolean {
  return session.sessionType !== "llm"
    && session.status !== "unknown"
    && Boolean(session.nodeId)
    && Boolean(session.agentId);
}

function editableDescriptionBlocks(blocks: readonly BlockDto[]): BlockDto[] {
  const childrenByParent = new Map<string | null, BlockDto[]>();
  for (const block of blocks) {
    const children = childrenByParent.get(block.parent_id) ?? [];
    children.push(block);
    childrenByParent.set(block.parent_id, children);
  }
  const editable: BlockDto[] = [];
  const visitEditableTree = (block: BlockDto): boolean => {
    if (!isEditableDescriptionBlock(block)) return false;
    return (childrenByParent.get(block.id) ?? []).every(visitEditableTree);
  };
  const collect = (block: BlockDto): void => {
    editable.push(block);
    for (const child of childrenByParent.get(block.id) ?? []) collect(child);
  };
  for (const root of childrenByParent.get(null) ?? []) {
    if (visitEditableTree(root)) collect(root);
  }
  return editable;
}

function isEditableDescriptionBlock(block: BlockDto): boolean {
  if (block.block_type !== "paragraph" && block.block_type !== "checklist") return false;
  return !/^\[\[[^\[\]]+\]\]$/.test(block.text.trim());
}

function compareSessionTime(left: SessionSummary, right: SessionSummary): number {
  return sessionTimestamp(left) - sessionTimestamp(right)
    || left.agentSessionId.localeCompare(right.agentSessionId);
}

function compareSessionTimeDescending(left: SessionSummary, right: SessionSummary): number {
  return compareSessionTime(right, left);
}

function sessionTimestamp(session: SessionSummary): number {
  const parsed = Date.parse(session.createdAt ?? session.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function missingSession(agentSessionId: string): SessionSummary {
  return {
    agentSessionId,
    status: "unknown",
    eventCount: 0,
  };
}
