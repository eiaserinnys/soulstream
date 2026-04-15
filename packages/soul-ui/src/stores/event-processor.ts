/**
 * SSE 이벤트 처리 로직
 *
 * dashboard-store의 processEvent/processEvents에서 사용하는 핵심 처리 함수.
 * 순수 함수로 분리하여 store set() 호출과 이벤트 처리 로직을 분리한다.
 */

import type {
  SessionSummary,
  SessionStatus,
  SoulSSEEvent,
  EventTreeNode,
  SessionNode,
  TextStartEvent,
  HistorySyncEvent,
} from "@shared/types";
import {
  type ProcessingContext,
  type TreeChangeInfo,
  ensureRoot,
} from "./processing-context";
import { createNodeFromEvent, applyUpdate } from "./node-factory";
import { placeInTree, handleTextStart } from "./tree-placer";
import { shouldNotify, deriveSessionStatus } from "./session-updater";

/** ensureRoot가 필요한 이벤트 타입 (text_delta, text_end, tool_result, subagent_stop 제외) */
const NEEDS_ROOT = new Set([
  "user_message", "session", "system_message", "intervention_sent", "thinking",
  "text_start", "subagent_start", "tool_start",
  "complete", "error", "result", "compact", "input_request",
  "assistant_message", "assistant_error",
]);

/**
 * 세션 루트 노드에 LLM 메타데이터를 설정한다.
 * ensureRoot() 직후 호출하여 루트가 처음 생성될 때만 메타데이터를 반영한다.
 */
function applyLlmMetadata(
  root: EventTreeNode,
  activeSessionSummary: SessionSummary | null,
): void {
  if (!activeSessionSummary || root.type !== "session") return;
  const sessionRoot = root as SessionNode;
  if (sessionRoot.sessionType != null) return; // 이미 설정됨

  if (activeSessionSummary.sessionType === "llm") {
    sessionRoot.sessionType = activeSessionSummary.sessionType;
    sessionRoot.llmProvider = activeSessionSummary.llmProvider;
    sessionRoot.llmModel = activeSessionSummary.llmModel;
  }
}

/** processEventSingle의 반환값 */
export interface SingleEventResult {
  root: EventTreeNode | null;
  updated: boolean;
  treeChangeInfo: TreeChangeInfo | null;
  statusUpdate: { agentSessionId: string; status: SessionStatus } | null;
  notify: boolean;
  newLastEventId: number;
  isHistorySync: boolean;
}

/**
 * 단일 SSE 이벤트를 트리에 적용하고 결과를 반환한다.
 * store의 set()은 호출하지 않는다 — 호출자(store action)가 결과를 보고 set()을 결정한다.
 */
export function processEventSingle(
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
  activeSessionKey: string | null,
  activeSessionSummary: SessionSummary | null,
  lastEventId: number,
): SingleEventResult {
  // Dedup
  if (eventId > 0 && eventId <= lastEventId) {
    return { root, updated: false, treeChangeInfo: null, statusUpdate: null, notify: false, newLastEventId: lastEventId, isHistorySync: false };
  }

  // history_sync
  if (event.type === "history_sync") {
    ctx.historySynced = true;
    const syncEvent = event as HistorySyncEvent;
    const statusUpdate = syncEvent.status && activeSessionKey
      ? { agentSessionId: activeSessionKey, status: syncEvent.status as SessionStatus }
      : null;
    return {
      root,
      updated: false,
      treeChangeInfo: null,
      statusUpdate,
      notify: false,
      newLastEventId: eventId > 0 ? eventId : lastEventId,
      isHistorySync: true,
    };
  }

  // root 보장
  if (NEEDS_ROOT.has(event.type)) {
    root = ensureRoot(root, ctx);
    applyLlmMetadata(root, activeSessionSummary);
  }

  // 노드 생성/배치/업데이트
  const node = createNodeFromEvent(event, eventId);
  let updated: boolean;

  if (node) {
    root = ensureRoot(root, ctx);
    placeInTree(node, event, eventId, ctx, root);
    updated = true;
  } else if (event.type === "text_start") {
    root = ensureRoot(root, ctx);
    updated = handleTextStart(event as TextStartEvent, eventId, ctx, root);
  } else {
    updated = applyUpdate(event, eventId, ctx, root);
  }

  // 세션 상태 갱신 (히스토리 리플레이 중에는 억제)
  let statusUpdate: { agentSessionId: string; status: SessionStatus } | null = null;
  if (ctx.historySynced) {
    const derivedStatus = deriveSessionStatus(event);
    if (derivedStatus && activeSessionKey) {
      statusUpdate = { agentSessionId: activeSessionKey, status: derivedStatus };
    }
  }

  // treeChangeInfo 분류
  const treeChangeInfo: TreeChangeInfo | null = updated
    ? (node
        ? { type: 'node-added', nodeId: node.id }
        : { type: 'node-updated', nodeId: ctx.activeTextTarget?.id })
    : null;

  const notify = ctx.historySynced && shouldNotify(event);

  return {
    root,
    updated,
    treeChangeInfo,
    statusUpdate,
    notify,
    newLastEventId: eventId,
    isHistorySync: false,
  };
}

/** processEventsBatch의 반환값 */
export interface BatchEventResult {
  root: EventTreeNode | null;
  updated: boolean;
  maxEventId: number;
  statusUpdates: Array<{ agentSessionId: string; status: SessionStatus }>;
  notifications: SoulSSEEvent[];
}

/**
 * SSE 이벤트 배치를 트리에 적용하고 결과를 반환한다.
 * 히스토리 리플레이 최적화: N개 이벤트의 트리 변경을 수행 후 결과만 반환.
 * store의 set()은 호출하지 않는다.
 */
export function processEventsBatch(
  events: Array<{ event: SoulSSEEvent; eventId: number }>,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
  activeSessionKey: string | null,
  activeSessionSummary: SessionSummary | null,
  lastEventId: number,
): BatchEventResult {
  let updated = false;
  let maxEventId = lastEventId;
  const statusUpdates: Array<{ agentSessionId: string; status: SessionStatus }> = [];
  const notifications: SoulSSEEvent[] = [];

  for (const { event, eventId } of events) {
    // Dedup
    if (eventId > 0 && eventId <= lastEventId) continue;
    if (eventId > maxEventId) maxEventId = eventId;

    // history_sync
    if (event.type === "history_sync") {
      ctx.historySynced = true;
      const syncEvent = event as HistorySyncEvent;
      if (syncEvent.status && activeSessionKey) {
        statusUpdates.push({ agentSessionId: activeSessionKey, status: syncEvent.status as SessionStatus });
      }
      continue;
    }

    // root 보장
    if (NEEDS_ROOT.has(event.type)) {
      root = ensureRoot(root, ctx);
      applyLlmMetadata(root, activeSessionSummary);
    }

    // 노드 생성/배치/업데이트
    const node = createNodeFromEvent(event, eventId);
    if (node) {
      root = ensureRoot(root, ctx);
      placeInTree(node, event, eventId, ctx, root);
      updated = true;
    } else if (event.type === "text_start") {
      root = ensureRoot(root, ctx);
      if (handleTextStart(event as TextStartEvent, eventId, ctx, root)) {
        updated = true;
      }
    } else {
      if (applyUpdate(event, eventId, ctx, root)) {
        updated = true;
      }
    }

    // 세션 상태 갱신 (히스토리 리플레이 중에는 억제)
    if (ctx.historySynced) {
      const derivedStatus = deriveSessionStatus(event);
      if (derivedStatus && activeSessionKey) {
        statusUpdates.push({ agentSessionId: activeSessionKey, status: derivedStatus });
      }
      if (shouldNotify(event)) {
        notifications.push(event);
      }
    }
  }

  return { root, updated, maxEventId, statusUpdates, notifications };
}
