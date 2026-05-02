/**
 * ChatView 메시지 그룹핑 로직
 *
 * 연속된 tool 메시지를 하나의 그룹으로 묶어서 접기/펼치기 UI로 표시한다.
 */

import type { ChatMessage } from "./flatten-tree";

export type MessageOrGroup =
  | { type: "single"; msg: ChatMessage }
  | { type: "tool-group"; messages: ChatMessage[] };

export function groupMessages(messages: ChatMessage[]): MessageOrGroup[] {
  const result: MessageOrGroup[] = [];
  let toolBuffer: ChatMessage[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      result.push({ type: "single", msg: toolBuffer[0] });
    } else {
      result.push({ type: "tool-group", messages: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      toolBuffer.push(msg);
    } else {
      flushTools();
      result.push({ type: "single", msg });
    }
  }
  flushTools();
  return result;
}
