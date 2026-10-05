/**
 * ChatView 메시지 그룹핑 로직
 *
 * 연속된 tool 메시지를 하나의 그룹으로 묶어서 접기/펼치기 UI로 표시한다.
 */

import type { ChatMessage } from "./flatten-tree";

export type BaseMessageOrGroup =
  | { type: "single"; msg: ChatMessage }
  | { type: "tool-group"; messages: ChatMessage[] };

export type MessageOrGroup =
  | BaseMessageOrGroup
  | {
      type: "summary-group";
      anchor: BaseMessageOrGroup;
      summaries: ChatMessage[];
    };

export function groupMessages(messages: ChatMessage[]): MessageOrGroup[] {
  const base: BaseMessageOrGroup[] = [];
  let toolBuffer: ChatMessage[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      base.push({ type: "single", msg: toolBuffer[0] });
    } else {
      base.push({ type: "tool-group", messages: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      toolBuffer.push(msg);
    } else {
      flushTools();
      base.push({ type: "single", msg });
    }
  }
  flushTools();
  const result: MessageOrGroup[] = [];
  for (const item of base) {
    const summary = item.type === "single" && item.msg.treeNodeType === "turn_summary"
      ? item.msg
      : null;
    if (summary === null || result.length === 0) {
      result.push(item);
      continue;
    }

    const previous = result[result.length - 1];
    if (previous.type === "summary-group") {
      result[result.length - 1] = {
        ...previous,
        summaries: [...previous.summaries, summary],
      };
    } else {
      result[result.length - 1] = {
        type: "summary-group",
        anchor: previous,
        summaries: [summary],
      };
    }
  }
  return result;
}
