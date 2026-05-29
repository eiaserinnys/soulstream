/**
 * Node Factory — 이벤트 타입에 따른 노드 생성 및 기존 노드 업데이트
 *
 * createNodeFromEvent: switch-case로 노드만 생성하여 반환 (트리 삽입, Map 조작 없음)
 * applyUpdate: 기존 노드를 수정하는 업데이트 이벤트 처리
 *
 * 주의: text_start는 노드 생성 + 트리 삽입을 동시에 수행하므로
 * tree-placer.ts의 handleTextStart()가 담당합니다.
 */

import type {
  EventTreeNode,
  InputRequestNodeDef,
  SoulSSEEvent,
  SessionEvent,
  SessionNode,
  ThinkingEvent,
  ToolStartEvent,
  ToolResultEvent,
  ToolNode,
  ResultEvent,
  CompleteEvent,
  ErrorEvent,
  UserMessageEvent,
  SystemMessageEvent,
  InterventionSentEvent,
  CompactEvent,
  InputRequestEvent,
  InputRequestExpiredEvent,
  InputRequestRespondedEvent,
  ToolApprovalRequestedEvent,
  ToolApprovalResolvedEvent,
  AgentUpdatedEvent,
  HandoffRequestedEvent,
  HandoffOccurredEvent,
  GuardrailTripwireEvent,
  AssistantMessageEvent,
  AssistantErrorEvent,
  AwaySummaryEvent,
  ToolApprovalNodeDef,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";
import { makeNode } from "./processing-context";

/** 이 길이를 초과하는 콘텐츠는 truncate하여 메모리를 절약한다 */
const TRUNCATE_THRESHOLD = 2000;
const PLACEHOLDER_TEXT = new Set(["{}", "[]", "null", "undefined"]);

function meaningfulDisplayText(value: string): string {
  const text = value.trim();
  if (!text || PLACEHOLDER_TEXT.has(text)) return "";
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

function appServerStreamKey(event: SoulSSEEvent): string | null {
  const toolUseId = (event as unknown as { tool_use_id?: unknown }).tool_use_id;
  return typeof toolUseId === "string" && toolUseId ? toolUseId : null;
}

/** LLM 세션의 messages 배열에서 마지막 user 메시지 콘텐츠를 추출한다. */
function extractLastUserContent(messages?: Array<{role: string; content: unknown}>): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((p): p is {type: string; text: string} =>
            typeof p === "object" && p !== null && p.type === "text")
          .map(p => p.text)
          .join(" ");
      }
      return "";
    }
  }
  return "";
}

/**
 * 이벤트에서 새 노드를 생성합니다.
 *
 * 생성형 이벤트만 노드를 반환하고, 업데이트형 이벤트는 null을 반환합니다.
 * 반환된 노드는 아직 트리에 삽입되지 않았고, Map에도 등록되지 않았습니다.
 * placeInTree()가 트리 삽입과 Map 등록을 담당합니다.
 *
 * 생성형: user_message, system_message, intervention_sent, thinking, tool_start, complete, error, result, compact, input_request, assistant_message, assistant_error
 * 무시: subagent_start, subagent_stop (R4: 가상 노드 미생성)
 * 업데이트형 (null 반환): session, text_start/delta/end, tool_result
 */
export function createNodeFromEvent(
  event: SoulSSEEvent,
  eventId: number,
): EventTreeNode | null {
  switch (event.type) {
    case "user_message": {
      const e = event as UserMessageEvent;
      const content = e.text ?? extractLastUserContent(e.messages);

      // caller_info(통합 v1, atom ed3a216d) → agentInfo + callerInfo 도출.
      // 정본 우선: nested e.caller_info. 부재 시 레거시 top-level fallback (Phase 3 이전 데이터).
      const ci = e.caller_info;
      const agentInfoFromCi = ci && ci.source === "agent" ? {
        source: "agent" as const,
        agent_node: ci.agent_node ?? "",
        agent_id: ci.agent_id ?? null,
        agent_name: ci.agent_name ?? null,
      } : undefined;
      const agentInfoLegacy = !ci && e.source === "agent" ? {
        source: e.source,
        agent_node: e.agent_node ?? "",
        agent_id: e.agent_id ?? null,
        agent_name: e.agent_name ?? null,
      } : undefined;

      return makeNode(`user-msg-${eventId}`, "user_message", content, {
        completed: true,
        user: e.user ?? e.client_id ?? "llm-proxy",
        context: e.context,
        agentInfo: agentInfoFromCi ?? agentInfoLegacy,
        callerInfo: ci,
      });
    }

    case "system_message": {
      const e = event as SystemMessageEvent;
      return makeNode(`system-msg-${eventId}`, "system_message", e.text, {
        completed: true,
      });
    }

    case "intervention_sent": {
      const e = event as InterventionSentEvent;
      // F-9 fix(2026-05-08): caller_info를 노드에 박아 InterventionMessage가 발신자
      // 단위 아바타·이름을 표시하게 한다. user_message 분기와 동일 패턴(agentInfo 도출).
      const ci = e.caller_info;
      const agentInfo = ci && ci.source === "agent" ? {
        source: "agent" as const,
        agent_node: ci.agent_node ?? "",
        agent_id: ci.agent_id ?? null,
        agent_name: ci.agent_name ?? null,
      } : undefined;
      return makeNode(`intervention-${eventId}`, "intervention", e.text, {
        completed: true,
        user: e.user,
        // Phase A context 정본 (Y-7, atom d7a1ad86 차단): user_message 분기(L100)와 대칭.
        // wire의 e.context를 노드에 박아 flatten-tree → ChatMessage.contextItems → InterventionMessage
        // ContextBlock으로 forward.
        context: e.context,
        agentInfo,
        callerInfo: ci,
      });
    }

    case "thinking": {
      const e = event as ThinkingEvent;
      const thinking = meaningfulDisplayText(e.thinking ?? e.text ?? "");
      if (!thinking) return null;
      const truncated = thinking && thinking.length > TRUNCATE_THRESHOLD;
      return makeNode(
        `thinking-${eventId}`,
        "thinking",
        truncated ? thinking.slice(0, TRUNCATE_THRESHOLD) : thinking,
        {
          completed: true,
          ...(truncated && { isTruncated: true, fullContentEventId: eventId }),
        },
      );
    }

    // R4/P0-A: subagent/runtime status events are state-only; no timeline node.
    case "subagent_start":
    case "claude_runtime_session_state":
    case "claude_runtime_task_started":
    case "claude_runtime_task_updated":
    case "claude_runtime_task_progress":
    case "claude_runtime_task_notification":
    case "claude_runtime_schedule_updated":
    case "claude_runtime_schedule_deleted":
      return null;

    case "tool_start": {
      const e = event as ToolStartEvent;
      return makeNode(`tool-${eventId}`, "tool", "", {
        toolName: e.tool_name,
        toolInput: e.tool_input,
        toolUseId: e.tool_use_id,
        toolTraceId: e.timeline_id,
        parentEventId: e.parent_event_id,
        timestamp: e.timestamp,
      });
    }

    case "complete": {
      const e = event as CompleteEvent;
      return makeNode(
        `complete-${eventId}`,
        "complete",
        e.result ?? "Session completed",
        {
          completed: true,
          usage: e.usage,
          totalCostUsd: e.total_cost_usd,
        },
      );
    }

    case "error": {
      const e = event as ErrorEvent;
      return makeNode(`error-${eventId}`, "error", e.message, {
        completed: true,
        isError: true,
      });
    }

    case "result": {
      const e = event as ResultEvent;
      return makeNode(
        `result-${eventId}`,
        "result",
        e.output ?? "Session completed",
        {
          completed: true,
          timestamp: e.timestamp,
          usage: e.usage,
          totalCostUsd: e.total_cost_usd,
          stopReason: e.stop_reason,
          errors: e.errors,
          modelUsage: e.model_usage,
          permissionDenials: e.permission_denials,
        },
      );
    }

    case "compact": {
      const e = event as CompactEvent;
      return makeNode(
        `compact-${eventId}`,
        "compact",
        e.message ?? "Context compaction occurred",
        { completed: true },
      );
    }

    case "input_request": {
      const e = event as InputRequestEvent;
      const firstQuestion = e.questions[0]?.question ?? "Input requested";
      return makeNode(`input-request-${eventId}`, "input_request", firstQuestion, {
        requestId: e.request_id,
        toolUseId: e.tool_use_id,
        questions: e.questions,
        parentEventId: e.parent_event_id,
        timestamp: e.timestamp,
        responded: false,
        receivedAt: e.started_at * 1000,
        timeoutSec: e.timeout_sec,
      });
    }

    case "tool_approval_requested": {
      const e = event as ToolApprovalRequestedEvent;
      return makeNode(`tool-approval-${eventId}`, "tool_approval", e.tool_name, {
        approvalId: e.approval_id,
        toolUseId: e.tool_use_id,
        toolName: e.tool_name,
        toolInput: e.tool_input,
        agentName: e.agent_name,
        timestamp: e.timestamp,
        resolved: false,
      });
    }

    case "agent_updated": {
      const e = event as AgentUpdatedEvent;
      return makeNode(`agent-updated-${eventId}`, "system_message", `Active agent: ${e.agent_name}`, {
        completed: true,
        timestamp: e.timestamp,
      });
    }

    case "handoff_requested": {
      const e = event as HandoffRequestedEvent;
      return makeNode(
        `handoff-requested-${eventId}`,
        "system_message",
        `Handoff requested: ${e.source_agent} -> ${e.target_agent}`,
        { completed: true, timestamp: e.timestamp },
      );
    }

    case "handoff_occurred": {
      const e = event as HandoffOccurredEvent;
      return makeNode(
        `handoff-occurred-${eventId}`,
        "system_message",
        `Handoff: ${e.source_agent} -> ${e.target_agent}`,
        { completed: true, timestamp: e.timestamp },
      );
    }

    case "guardrail_tripwire": {
      const e = event as GuardrailTripwireEvent;
      return makeNode(
        `guardrail-${eventId}`,
        "error",
        `${e.guardrail_name}: ${e.message}`,
        { completed: true, isError: true, timestamp: e.timestamp },
      );
    }

    case "assistant_message": {
      const e = event as AssistantMessageEvent;
      return makeNode(`asst-msg-${eventId}`, "assistant_message", e.content, {
        completed: true,
        model: e.model,
        provider: e.provider,
        usage: e.usage,
        timestamp: e.timestamp,
      });
    }

    case "away_summary": {
      const e = event as AwaySummaryEvent;
      return makeNode(`away-summary-${eventId}`, "away_summary", e.content, {
        completed: true,
        parentEventId: e.parent_event_id,
        timestamp: e.timestamp,
      });
    }

    case "assistant_error": {
      const e = event as AssistantErrorEvent;
      return makeNode(
        `asst-error-${eventId}`,
        "assistant_error",
        `API Error: ${e.error_type}`,
        {
          completed: true,
          isError: true,
          errorType: e.error_type,
          model: e.model,
          messageId: e.message_id,
          parentEventId: e.parent_event_id,
          timestamp: e.timestamp,
        },
      );
    }

    default:
      return null;
  }
}

export function applyFinalAssistantMessageToLiveText(
  event: SoulSSEEvent,
  ctx: ProcessingContext,
): boolean {
  if (event.type !== "assistant_message") return false;
  if ((event as unknown as { _final_for_live_stream?: unknown })._final_for_live_stream !== true) {
    return false;
  }
  const streamKey = appServerStreamKey(event);
  if (!streamKey) return false;
  ctx.finalizedTextStreams.add(streamKey);
  const target = ctx.nodeMap.get(`app-server-agent-message:${streamKey}`);
  if (!target || target.type !== "text") return false;
  const e = event as AssistantMessageEvent;
  target.content = e.content;
  target.completed = true;
  target.textCompleted = true;
  if (ctx.activeTextTarget === target) ctx.activeTextTarget = null;
  return true;
}

/**
 * 기존 노드를 수정하는 업데이트 이벤트를 처리합니다.
 *
 * session: 루트 노드의 sessionId/content 갱신
 * text_delta: activeTextTarget 텍스트 누적
 * text_end: activeTextTarget 완료 마킹
 * tool_result: tool 노드에 결과 반영
 *
 * 주의: text_start는 tree-placer.ts의 handleTextStart()가 담당합니다.
 *
 * @returns 트리가 변경되었으면 true, 아무 변경도 없으면 false
 */
export function applyUpdate(
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode | null,
): boolean {
  switch (event.type) {
    case "session": {
      if (!root || root.type !== "session") return false;
      const e = event as SessionEvent;
      const sessionRoot = root as SessionNode;
      sessionRoot.sessionId = e.session_id;
      sessionRoot.pid = e.pid;
      root.content = e.session_id;
      return true;
    }

    case "text_delta": {
      if (ctx.activeTextTarget) {
        ctx.activeTextTarget.content += event.text;
        return true;
      }
      return false;
    }

    case "text_end": {
      if (ctx.activeTextTarget) {
        ctx.activeTextTarget.textCompleted = true;
        ctx.activeTextTarget.completed = true;
        ctx.activeTextTarget = null;
        return true;
      }
      return false;
    }

    case "tool_result": {
      const e = event as ToolResultEvent;
      // tool_use_id로 nodeMap에서 정확 매칭 (Phase 6: toolUseMap 통합)
      const found = e.tool_use_id
        ? ctx.nodeMap.get(e.tool_use_id)
        : undefined;

      if (found && (found.type === "tool" || found.type === "tool_use")) {
        const toolNode = found as ToolNode;
        const result = e.result;
        if (result && result.length > TRUNCATE_THRESHOLD) {
          toolNode.toolResult = result.slice(0, TRUNCATE_THRESHOLD);
          toolNode.isTruncated = true;
          toolNode.fullContentEventId = eventId;
        } else {
          toolNode.toolResult = result;
        }
        toolNode.isError = e.is_error;
        if (e.timeline_id) toolNode.toolTraceId = e.timeline_id;
        toolNode.completed = true;
        // timestamp 차이로 duration 계산
        if (toolNode.timestamp && e.timestamp) {
          toolNode.durationMs = Math.round(
            (e.timestamp - toolNode.timestamp) * 1000,
          );
        }
        return true;
      }
      return false;
    }

    case "input_request_expired": {
      const e = event as InputRequestExpiredEvent;
      const node = ctx.nodeMap.get(e.request_id);
      if (node && node.type === "input_request") {
        // expired = true 즉시 설정하면 findPendingInputRequest가 배너를 즉시 필터링함
        // 대신 serverExpiredAt으로 "만료 신호"만 전달 — AskQuestionBanner가 2초 후 expireInputRequest 호출
        (node as InputRequestNodeDef).serverExpiredAt = Date.now();
        return true;  // treeVersion++ → 리렌더 트리거 (배너에서 serverExpiredAt 감지)
      }
      return false;
    }

    case "input_request_responded": {
      const e = event as InputRequestRespondedEvent;
      const node = ctx.nodeMap.get(e.request_id);
      if (node && node.type === "input_request") {
        (node as InputRequestNodeDef).responded = true;
        (node as InputRequestNodeDef).completed = true;
        return true;  // treeVersion++ → 배너 리렌더 → findPendingInputRequest가 필터링
      }
      return false;
    }

    case "tool_approval_resolved": {
      const e = event as ToolApprovalResolvedEvent;
      const node = ctx.nodeMap.get(e.approval_id);
      if (node && node.type === "tool_approval") {
        const approvalNode = node as ToolApprovalNodeDef;
        approvalNode.resolved = true;
        approvalNode.completed = true;
        approvalNode.approved = e.approved;
        approvalNode.rejected = e.rejected;
        approvalNode.message = e.message;
        return true;
      }
      return false;
    }

    // R4/P0-A: subagent/runtime status events are state-only; no timeline node.
    case "subagent_stop":
    case "claude_runtime_session_state":
    case "claude_runtime_task_started":
    case "claude_runtime_task_updated":
    case "claude_runtime_task_progress":
    case "claude_runtime_task_notification":
    case "claude_runtime_schedule_updated":
    case "claude_runtime_schedule_deleted":
      return false;

    default:
      return false;
  }
}
