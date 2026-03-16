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
  InterventionSentEvent,
  CompactEvent,
  InputRequestEvent,
  AssistantMessageEvent,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";
import { makeNode } from "./processing-context";

/** 이 길이를 초과하는 콘텐츠는 truncate하여 메모리를 절약한다 */
const TRUNCATE_THRESHOLD = 2000;

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
 * 생성형: user_message, intervention_sent, thinking, tool_start, complete, error, result, compact, input_request, assistant_message
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
      return makeNode(`user-msg-${eventId}`, "user_message", content, {
        completed: true,
        user: e.user ?? e.client_id ?? "llm-proxy",
        context: e.context,
      });
    }

    case "intervention_sent": {
      const e = event as InterventionSentEvent;
      return makeNode(`intervention-${eventId}`, "intervention", e.text, {
        completed: true,
        user: e.user,
      });
    }

    case "thinking": {
      const e = event as ThinkingEvent;
      const thinking = e.thinking;
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

    // R4: subagent_start/stop은 무시 — 가상 노드를 생성하지 않음
    case "subagent_start":
      return null;

    case "tool_start": {
      const e = event as ToolStartEvent;
      return makeNode(`tool-${eventId}`, "tool", "", {
        toolName: e.tool_name,
        toolInput: e.tool_input,
        toolUseId: e.tool_use_id,
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
        { completed: true },
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
        receivedAt: Date.now(),
      });
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

    default:
      return null;
  }
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

    // R4: subagent_stop은 무시 — subagent 가상 노드가 없으므로 완료 마킹 불필요
    case "subagent_stop":
      return false;

    default:
      return false;
  }
}
