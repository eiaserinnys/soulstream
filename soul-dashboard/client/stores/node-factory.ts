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
  ThinkingEvent,
  ToolStartEvent,
  ToolResultEvent,
  ResultEvent,
  CompleteEvent,
  ErrorEvent,
  UserMessageEvent,
  InterventionSentEvent,
  CompactEvent,
} from "@shared/types";
import type { ProcessingContext } from "./processing-context";
import { makeNode } from "./processing-context";

/**
 * 이벤트에서 새 노드를 생성합니다.
 *
 * 생성형 이벤트만 노드를 반환하고, 업데이트형 이벤트는 null을 반환합니다.
 * 반환된 노드는 아직 트리에 삽입되지 않았고, Map에도 등록되지 않았습니다.
 * placeInTree()가 트리 삽입과 Map 등록을 담당합니다.
 *
 * 생성형: user_message, intervention_sent, thinking, tool_start, complete, error, result, compact
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
      return makeNode(`user-msg-${eventId}`, "user_message", e.text, {
        completed: true,
        user: e.user,
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
      return makeNode(`thinking-${eventId}`, "thinking", e.thinking, {
        completed: true,
      });
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
        parentToolUseId: e.parent_tool_use_id,
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
      if (!root) return false;
      const e = event as SessionEvent;
      root.sessionId = e.session_id;
      root.content = e.session_id;
      return true;
    }

    case "text_delta": {
      if (ctx.activeTextTarget) {
        if (ctx.activeTextTarget.type === "thinking") {
          // thinking 노드의 가시적 텍스트 갱신
          ctx.activeTextTarget.textContent =
            (ctx.activeTextTarget.textContent ?? "") + event.text;
        } else {
          // 독립 text 노드의 content 갱신
          ctx.activeTextTarget.content += event.text;
        }
        return true;
      }
      return false;
    }

    case "text_end": {
      if (ctx.activeTextTarget) {
        ctx.activeTextTarget.textCompleted = true;
        if (ctx.activeTextTarget.type !== "thinking") {
          ctx.activeTextTarget.completed = true;
        }
        ctx.activeTextTarget = null;
        return true;
      }
      return false;
    }

    case "tool_result": {
      const e = event as ToolResultEvent;
      // tool_use_id 정확 매칭만 (폴백 없음)
      const toolNode = e.tool_use_id
        ? ctx.toolUseMap.get(e.tool_use_id)
        : undefined;

      if (toolNode) {
        toolNode.toolResult = e.result;
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
