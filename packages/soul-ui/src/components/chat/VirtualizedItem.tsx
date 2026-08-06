import { memo } from "react";
import type { LlmContext } from "./hooks";
import { ToolCallGroup } from "./ToolCallGroup";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatThinkingIndicator } from "./ChatThinkingIndicator";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";

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

export type VirtualizedItemProps = {
  item: ChatTimelineItem;
  llmContext?: LlmContext;
  sessionId?: string;
};

function VirtualizedItemImpl({ item, llmContext, sessionId }: VirtualizedItemProps) {
  if (item.type === "thinking-indicator") {
    return <ChatThinkingIndicator />;
  }
  if (item.type === "summary-group") {
    return (
      <>
        <VirtualizedItemImpl
          item={item.anchor}
          llmContext={llmContext}
          sessionId={sessionId}
        />
        {item.summaries.map((summary) => (
          <ChatMessageItem
            key={summary.treeNodeId}
            msg={summary}
            llmContext={llmContext}
            sessionId={sessionId}
          />
        ))}
      </>
    );
  }
  if (item.type === "tool-group") {
    return <ToolCallGroup messages={item.messages} />;
  }
  return (
    <ChatMessageItem msg={item.msg} llmContext={llmContext} sessionId={sessionId} />
  );
}

/**
 * memo 기본 shallow 비교는 wrapper 객체({type, msg|messages})가 매번 새 reference로
 * 생성되어 항상 fail한다 (lib/grouping.ts groupMessages가 매 호출마다 새 wrapper를
 * push하기 때문). arePropsEqual로 wrapper 안쪽의 ChatMessage reference 동일성을
 * 비교하여 flatten-tree identity 캐시의 효과를 VirtualizedItem까지 전달한다.
 *
 * ChatMessageItem 시그니처({msg, llmContext?, sessionId?})는 닫혀 있어 onClick 등
 * 새 reference로 재생성되는 추가 props 위험이 없다. ChatMessageItem 자체도 memo로
 * 별도 보호되어 이중 안전망.
 */
export function arePropsEqual(prev: VirtualizedItemProps, next: VirtualizedItemProps): boolean {
  if (prev.llmContext !== next.llmContext) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.item.type !== next.item.type) return false;
  if (
    prev.item.type === "thinking-indicator" &&
    next.item.type === "thinking-indicator"
  ) return true;
  if (prev.item.type === "single" && next.item.type === "single") {
    return prev.item.msg === next.item.msg;
  }
  if (prev.item.type === "tool-group" && next.item.type === "tool-group") {
    const a = prev.item.messages;
    const b = next.item.messages;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (prev.item.type === "summary-group" && next.item.type === "summary-group") {
    if (!arePropsEqual(
      { ...prev, item: prev.item.anchor },
      { ...next, item: next.item.anchor },
    )) return false;
    const a = prev.item.summaries;
    const b = next.item.summaries;
    return a.length === b.length && a.every((summary, index) => summary === b[index]);
  }
  return false;
}

export const VirtualizedItem = memo(VirtualizedItemImpl, arePropsEqual);
