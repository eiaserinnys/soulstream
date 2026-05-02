import { memo } from "react";
import type { LlmContext } from "./hooks";
import type { MessageOrGroup } from "../../lib/grouping";
import { ToolCallGroup } from "./ToolCallGroup";
import { ChatMessageItem } from "./ChatMessageItem";

/**
 * ChatView의 리스트 항목 렌더러.
 *
 * Phase 4에서 `@tanstack/react-virtual` → `react-virtuoso`로 교체하면서
 * 외부에서 주입하던 `vi`(VirtualItem) 및 `measureElement` 바인딩이 제거되었다.
 * virtuoso는 내부 `ResizeObserver`로 항목을 측정하므로 외부 ref 바인딩이 필요 없다.
 *
 * `data-tree-node-id` 등 하위 컴포넌트가 노출하는 DOM 속성은 그대로 유지되며,
 * ChatView의 `itemsRendered` 콜백이 해당 속성으로 포커스 하이라이트 타겟을 찾는다.
 */
export const VirtualizedItem = memo(function VirtualizedItem({
  item,
  llmContext,
  sessionId,
}: {
  item: MessageOrGroup;
  llmContext?: LlmContext;
  sessionId?: string;
}) {
  if (item.type === "tool-group") {
    return <ToolCallGroup messages={item.messages} />;
  }
  return (
    <ChatMessageItem msg={item.msg} llmContext={llmContext} sessionId={sessionId} />
  );
});
