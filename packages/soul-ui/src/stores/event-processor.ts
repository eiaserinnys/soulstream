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
  SubtreeUpdateSSEEvent,
  PromptSuggestionEvent,
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
  "assistant_message", "assistant_error", "away_summary",
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

/**
 * subtree_update 결과 — nodeMap 증분 적용용.
 *
 * 서버가 Python `dict[int, int]`로 보내지만 JSON 직렬화로 key는 string.
 * 소비자(store reducer)가 `nodeMap.get(String(idStr))`로 조회한다
 * (nodeMap key는 _event_id가 `String(eventId)`로 등록되어 있음).
 */
export interface SubtreeHeightUpdate {
  /** ancestor_id(string) → +delta 매핑 */
  deltas: Record<string, number>;
  /** 갱신 후 totalSubtreeHeight 정본 */
  newTotal: number;
  /** 이 배치에서 영향받은 이벤트 ID 목록 (디버깅용) */
  affectedIds: number[];
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
  /** subtree_update 이벤트 발생 시 설정됨 — store reducer가 nodeMap·totalSubtreeHeight 증분 적용 */
  subtreeHeightUpdate?: SubtreeHeightUpdate | null;
  /** prompt_suggestion 이벤트 발생 시 설정됨 — store reducer가 lastPromptSuggestions[sessionId]에 적용 */
  promptSuggestion?: { sessionId: string; text: string } | null;
  /** text_start 등 응답 시작 이벤트 발생 시 설정됨 — store reducer가 해당 세션의 suggestion clear */
  clearPromptSuggestionFor?: string | null;
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

  // subtree_update — 노드 생성·트리 변경 없이 nodeMap 증분만 갱신한다.
  // store reducer가 subtreeHeightUpdate를 받아 nodeMap과 totalSubtreeHeight에 적용한다.
  if (event.type === "subtree_update") {
    const ev = event as SubtreeUpdateSSEEvent;
    return {
      root,
      updated: false,
      treeChangeInfo: null,
      statusUpdate: null,
      notify: false,
      newLastEventId: eventId > 0 ? eventId : lastEventId,
      isHistorySync: false,
      subtreeHeightUpdate: {
        deltas: ev.deltas,
        newTotal: ev.new_total_subtree_height,
        affectedIds: ev.affected_event_ids,
      },
    };
  }

  // prompt_suggestion — chip 표시용. 트리에는 들어가지 않음.
  if (event.type === "prompt_suggestion") {
    const ev = event as PromptSuggestionEvent;
    return {
      root,
      updated: false,
      treeChangeInfo: null,
      statusUpdate: null,
      notify: false,
      newLastEventId: eventId > 0 ? eventId : lastEventId,
      isHistorySync: false,
      promptSuggestion: activeSessionKey
        ? { sessionId: activeSessionKey, text: ev.text }
        : null,
    };
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
    clearPromptSuggestionFor:
      event.type === "text_start" && activeSessionKey ? activeSessionKey : null,
  };
}

/** processEventsBatch의 반환값 */
export interface BatchEventResult {
  root: EventTreeNode | null;
  updated: boolean;
  maxEventId: number;
  statusUpdates: Array<{ agentSessionId: string; status: SessionStatus }>;
  notifications: SoulSSEEvent[];
  /**
   * 배치 내 subtree_update 집계 결과 — deltas는 합산, newTotal은 마지막 값.
   * subtree_update가 없으면 null.
   */
  subtreeHeightUpdate: SubtreeHeightUpdate | null;
  /**
   * 배치 내 마지막 prompt_suggestion (later wins).
   * 없으면 null.
   */
  promptSuggestion: { sessionId: string; text: string } | null;
  /**
   * 배치에 text_start가 포함되어 있으면 해당 세션의 chip을 clear할 sessionId.
   * 없으면 null.
   */
  clearPromptSuggestionFor: string | null;
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

  // subtree_update 집계 상태 — 배치 내 여러 subtree_update가 올 수 있으므로 합산한다.
  let aggregatedDeltas: Record<string, number> | null = null;
  let latestNewTotal: number | null = null;
  const aggregatedAffectedIds: number[] = [];

  // prompt_suggestion / text_start 추적 — later wins.
  let promptSuggestion: { sessionId: string; text: string } | null = null;
  let clearPromptSuggestionFor: string | null = null;

  for (const { event, eventId } of events) {
    // Dedup — 라이브 SSE 배치 간 중복만 차단.
    // historyMode prepend는 의도적으로 과거 eventId(< lastEventId)를 처리하므로 우회.
    // 같은 배치 내 ancestor 중복은 placeInTree의 nodeMap.has() 가드(tree-placer.ts)가 차단.
    if (!ctx.historyMode && eventId > 0 && eventId <= lastEventId) continue;
    if (eventId > maxEventId) maxEventId = eventId;

    // subtree_update — 트리 변경 없이 deltas만 집계한다.
    if (event.type === "subtree_update") {
      const ev = event as SubtreeUpdateSSEEvent;
      if (aggregatedDeltas === null) aggregatedDeltas = {};
      for (const [idStr, delta] of Object.entries(ev.deltas)) {
        aggregatedDeltas[idStr] = (aggregatedDeltas[idStr] ?? 0) + delta;
      }
      latestNewTotal = ev.new_total_subtree_height;
      for (const id of ev.affected_event_ids) aggregatedAffectedIds.push(id);
      continue;
    }

    // prompt_suggestion — chip 표시용. 트리 변경 없음. later wins.
    if (event.type === "prompt_suggestion") {
      const ev = event as PromptSuggestionEvent;
      if (activeSessionKey) {
        promptSuggestion = { sessionId: activeSessionKey, text: ev.text };
      }
      continue;
    }

    // text_start — 응답 시작 시 chip clear 신호.
    if (event.type === "text_start" && activeSessionKey) {
      clearPromptSuggestionFor = activeSessionKey;
      // text_start는 트리 처리도 필요하므로 continue하지 않는다.
    }

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

  const subtreeHeightUpdate: SubtreeHeightUpdate | null =
    aggregatedDeltas !== null && latestNewTotal !== null
      ? { deltas: aggregatedDeltas, newTotal: latestNewTotal, affectedIds: aggregatedAffectedIds }
      : null;

  return {
    root,
    updated,
    maxEventId,
    statusUpdates,
    notifications,
    subtreeHeightUpdate,
    promptSuggestion,
    clearPromptSuggestionFor,
  };
}
