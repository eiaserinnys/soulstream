/**
 * SSE 이벤트 처리 로직
 *
 * dashboard-store의 processEvent/processEvents에서 사용하는 핵심 처리 함수.
 * 순수 함수로 분리하여 store set() 호출과 이벤트 처리 로직을 분리한다.
 *
 * Phase 2-A 평탄화 (atom 작업 이력 260507.01.fe-tree-flattening, §11.1 옵션 C):
 *   - subtree_update SSE 처리는 dedup 갱신만 하고 트리 변경 없음 (no-op return).
 *     백엔드는 계속 송출하지만 FE는 무시한다 (Phase 2-B 후속 카드에서 백엔드 발신 정리).
 *   - treeChangeInfo 분류·SubtreeHeightUpdate 인터페이스는 NodeGraph 제거(Phase 1) 후
 *     소비자 0건이라 폐기. P1 의존성으로 event-processing-slice도 함께 정리한다.
 *   - tree-placer가 root.children에 평면 push하므로 historyMode 분기 / orphan 큐는 사라졌다.
 *   - placeInTree 호출 의미는 그대로 유지(시그니처 무변경).
 */

import type {
  SessionSummary,
  SessionStatus,
  SoulSSEEvent,
  EventTreeNode,
  SessionNode,
  TextStartEvent,
  HistorySyncEvent,
  PromptSuggestionEvent,
} from "@shared/types";
import {
  type ProcessingContext,
  ensureRoot,
} from "./processing-context";
import {
  createNodeFromEvent,
  applyFinalAssistantMessageToLiveText,
  applyUpdate,
} from "./node-factory";
import { placeInTree, handleTextStart } from "./tree-placer";
import { shouldNotify, deriveSessionStatus } from "./session-updater";

/** ensureRoot가 필요한 이벤트 타입 (text_delta, text_end, tool_result, subagent_stop 제외) */
const NEEDS_ROOT = new Set([
  "user_message", "session", "system_message", "intervention_sent", "thinking",
  "text_start", "subagent_start", "tool_start",
  "complete", "error", "result", "compact", "input_request",
  "tool_approval_requested", "agent_updated", "handoff_requested", "handoff_occurred",
  "guardrail_tripwire", "assistant_message", "assistant_error", "away_summary",
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
  statusUpdate: { agentSessionId: string; status: SessionStatus } | null;
  notify: boolean;
  newLastEventId: number;
  isHistorySync: boolean;
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
    return { root, updated: false, statusUpdate: null, notify: false, newLastEventId: lastEventId, isHistorySync: false };
  }

  // subtree_update / runbook_updated / custom_view_updated — 트리 변경 없음, dedup만 갱신.
  // 보드 live 갱신은 session stream projection stores가 처리한다.
  if (event.type === "subtree_update" || event.type === "runbook_updated" || event.type === "custom_view_updated") {
    return {
      root,
      updated: false,
      statusUpdate: null,
      notify: false,
      newLastEventId: eventId > 0 ? eventId : lastEventId,
      isHistorySync: false,
    };
  }

  // prompt_suggestion — chip 표시용. 트리에는 들어가지 않음.
  if (event.type === "prompt_suggestion") {
    const ev = event as PromptSuggestionEvent;
    return {
      root,
      updated: false,
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
  const replacedLiveText = applyFinalAssistantMessageToLiveText(event, ctx);
  const node = replacedLiveText ? null : createNodeFromEvent(event, eventId);
  let updated: boolean;

  if (replacedLiveText) {
    updated = true;
  } else if (node) {
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

  const notify = ctx.historySynced && shouldNotify(event);

  return {
    root,
    updated,
    statusUpdate,
    notify,
    newLastEventId: eventId > 0 ? eventId : lastEventId,
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
  /** 배치 내 마지막 prompt_suggestion (later wins). 없으면 null. */
  promptSuggestion: { sessionId: string; text: string } | null;
  /** 배치에 text_start가 포함되어 있으면 해당 세션의 chip을 clear할 sessionId. 없으면 null. */
  clearPromptSuggestionFor: string | null;
}

/**
 * SSE 이벤트 배치를 트리에 적용하고 결과를 반환한다.
 * 히스토리 리플레이 최적화: N개 이벤트의 트리 변경을 수행 후 결과만 반환.
 * store의 set()은 호출하지 않는다.
 *
 * @param skipDedup history prepend 경로(processHistoryEvents) 전용. true면 lastEventId 이하 과거
 *   이벤트도 의도적으로 처리한다. 같은 배치 내 같은 eventId 중복은 placeInTree의 nodeMap.has 가드가
 *   silent skip하므로 안전. 라이브 SSE 경로는 false(기본)로 호출하여 배치 간 중복을 차단한다.
 *   design-principles §6(전달은 파라미터로) — caller가 의도를 명시 전달.
 */
export function processEventsBatch(
  events: Array<{ event: SoulSSEEvent; eventId: number }>,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
  activeSessionKey: string | null,
  activeSessionSummary: SessionSummary | null,
  lastEventId: number,
  skipDedup = false,
): BatchEventResult {
  let updated = false;
  let maxEventId = lastEventId;
  const statusUpdates: Array<{ agentSessionId: string; status: SessionStatus }> = [];
  const notifications: SoulSSEEvent[] = [];

  // prompt_suggestion / text_start 추적 — later wins.
  let promptSuggestion: { sessionId: string; text: string } | null = null;
  let clearPromptSuggestionFor: string | null = null;

  for (const { event, eventId } of events) {
    // Dedup — 라이브 SSE 배치 간 중복만 차단. skipDedup=true(history prepend)면 우회.
    // 같은 배치 내 ancestor 동봉 중복은 placeInTree의 nodeMap.has 가드가 silent skip.
    if (!skipDedup && eventId > 0 && eventId <= lastEventId) continue;
    if (eventId > maxEventId) maxEventId = eventId;

    // subtree_update / runbook_updated / custom_view_updated — 트리 변경 없음, dedup만 갱신.
    if (event.type === "subtree_update" || event.type === "runbook_updated" || event.type === "custom_view_updated") {
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
    const replacedLiveText = applyFinalAssistantMessageToLiveText(event, ctx);
    const node = replacedLiveText ? null : createNodeFromEvent(event, eventId);
    if (replacedLiveText) {
      updated = true;
    } else if (node) {
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

  return {
    root,
    updated,
    maxEventId,
    statusUpdates,
    notifications,
    promptSuggestion,
    clearPromptSuggestionFor,
  };
}
