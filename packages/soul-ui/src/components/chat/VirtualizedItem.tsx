import { memo } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { LlmContext } from "./hooks";
import type { MessageOrGroup } from "./grouping";
import { ToolCallGroup } from "./ToolCallGroup";
import { ChatMessageItem } from "./ChatMessageItem";

export const VirtualizedItem = memo(function VirtualizedItem({
  vi,
  item,
  measureElement,
  llmContext,
  sessionId,
}: {
  vi: VirtualItem;
  item: MessageOrGroup;
  measureElement: (el: HTMLElement | null) => void;
  llmContext?: LlmContext;
  sessionId?: string;
}) {
  return (
    <div
      ref={measureElement}
      data-index={vi.index}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${vi.start}px)`,
      }}
    >
      {item.type === "tool-group" ? (
        <ToolCallGroup messages={item.messages} />
      ) : (
        <ChatMessageItem msg={item.msg} llmContext={llmContext} sessionId={sessionId} />
      )}
    </div>
  );
});
