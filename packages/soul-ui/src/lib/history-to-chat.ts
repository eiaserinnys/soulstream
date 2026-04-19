/**
 * history-to-chat — HistoricalMessage → ChatMessage 어댑터
 *
 * DB messages API가 반환하는 HistoricalMessage를 ChatView가
 * 렌더링하는 ChatMessage 형식으로 변환한다.
 *
 * HistoricalMessage.payload는 원본 SSE 이벤트의 JSON이며,
 * event_type에 따라 ChatMessage 필드를 채운다.
 */

import type { ChatMessage } from "./flatten-tree";
import type { HistoricalMessage } from "../components/chat/useMessageHistoryBuffer";

/**
 * HistoricalMessage 배열을 ChatMessage 배열로 변환한다.
 * session, history_sync 등 ChatView에 표시하지 않는 이벤트 타입은 건너뛴다.
 */
export function historicalToChatMessages(
  messages: HistoricalMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const m of messages) {
    const cm = historicalToChatMessage(m);
    if (cm) result.push(cm);
  }
  return result;
}

function historicalToChatMessage(m: HistoricalMessage): ChatMessage | null {
  const p = m.payload;
  const treeNodeId = `node-${m.event_type}-${m.id}`;
  const timestamp = m.created_at ? new Date(m.created_at).getTime() : undefined;

  switch (m.event_type) {
    case "user_message":
      return {
        id: treeNodeId,
        role: "user",
        content: (p.content as string) ?? "",
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "system_message":
      return {
        id: treeNodeId,
        role: "system_message",
        content: (p.content as string) ?? "",
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "intervention":
      return {
        id: treeNodeId,
        role: "intervention",
        content: (p.content as string) ?? "",
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "thinking":
      return {
        id: treeNodeId,
        role: "assistant",
        content: (p.content as string) ?? "",
        thinkingContent: (p.content as string) ?? "",
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "text":
      return {
        id: treeNodeId,
        role: "assistant",
        content: (p.content as string) ?? "",
        timestamp,
        isStreaming: false,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "tool": {
      const toolName = (p.name as string) ?? (p.tool_name as string) ?? "unknown";
      return {
        id: treeNodeId,
        role: "tool",
        content: toolName,
        toolName,
        toolDurationMs: p.duration_ms as number | undefined,
        isError: (p.is_error as boolean) ?? false,
        toolInput: p.input as Record<string, unknown> | undefined,
        toolResult: p.result as string | undefined,
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };
    }

    case "result":
      return {
        id: treeNodeId,
        role: "system",
        content: `Session ${(p.subtype as string) ?? "completed"}`,
        timestamp,
        usage: p.usage as { input_tokens: number; output_tokens: number } | undefined,
        totalCostUsd: p.total_cost_usd as number | undefined,
        durationMs: p.duration_ms as number | undefined,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "assistant_message":
      return {
        id: treeNodeId,
        role: "assistant",
        content: (p.content as string) ?? "",
        timestamp,
        model: p.model as string | undefined,
        provider: p.provider as string | undefined,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "input_request":
      return {
        id: treeNodeId,
        role: "input_request",
        content: (p.description as string) ?? "",
        timestamp,
        questions: p.questions as ChatMessage["questions"],
        requestId: p.request_id as string | undefined,
        responded: (p.responded as boolean) ?? false,
        expired: (p.expired as boolean) ?? false,
        timeoutSec: p.timeout_sec as number | undefined,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    case "away_summary":
      return {
        id: treeNodeId,
        role: "away_summary",
        content: (p.content as string) ?? "",
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };

    // 표시하지 않는 이벤트 타입
    case "session":
    case "history_sync":
    case "subtree_update":
    case "complete":
    case "error":
    case "text_delta":
    case "thinking_delta":
    case "session_updated":
      return null;

    default:
      // 알 수 없는 타입은 system 메시지로 표시
      return {
        id: treeNodeId,
        role: "system",
        content: `[${m.event_type}]`,
        timestamp,
        treeNodeId,
        treeNodeType: m.event_type,
        eventId: m.id,
      };
  }
}
