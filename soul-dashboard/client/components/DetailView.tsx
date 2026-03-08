/**
 * DetailView - 선택된 카드/노드의 상세 정보 패널
 *
 * 카드 타입에 따라 적절한 상세 컴포넌트를 라우팅합니다.
 * - text 카드 → ThinkingDetail
 * - tool 카드 (Task) → SubAgentDetail
 * - tool 카드 (에러) → ErrorDetail
 * - tool 카드 (일반) → ToolDetail
 * - complete 카드 → CompleteDetail
 * - user/intervention 이벤트 노드 → EventNodeDetail
 */

import type { EventTreeNode, ToolNode } from "@shared/types";
import { useDashboardStore, findTreeNode, type SelectedEventNodeData } from "../stores/dashboard-store";
import { ThinkingDetail } from "./detail/ThinkingDetail";
import { ToolDetail } from "./detail/ToolDetail";
import { SubAgentDetail } from "./detail/SubAgentDetail";
import { ErrorDetail } from "./detail/ErrorDetail";
import { SectionLabel, CodeBlock } from "./detail/shared";
import { ScrollArea } from "./ui/scroll-area";

// === Complete Detail ===

/**
 * complete 타입 노드의 상세 뷰.
 * ThinkingDetail과 유사하지만 성공(green) 스타일링을 적용합니다.
 */
function CompleteDetail({ card }: { card: EventTreeNode }) {
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-base">{"\u2705"}</span>
        <div className="text-[12px] text-success uppercase tracking-[0.05em] font-semibold">
          Complete
        </div>
      </div>
      <pre className="text-[14px] text-foreground whitespace-pre-wrap break-words leading-relaxed m-0 font-mono">
        {card.content || "Session completed"}
      </pre>
      {card.content && (
        <div className="text-[11px] text-muted-foreground/60 text-right">
          {card.content.length.toLocaleString()} chars
        </div>
      )}
    </div>
  );
}

// === Detail Router ===

/**
 * 카드 타입에 따라 적절한 상세 컴포넌트를 선택합니다.
 *
 * 우선순위:
 * 1. tool + toolName === "Task" → SubAgentDetail
 * 2. tool + isError === true → ErrorDetail
 * 3. tool → ToolDetail
 * 4. text/thinking → ThinkingDetail
 * 5. complete → CompleteDetail
 */
function CardDetail({ card }: { card: EventTreeNode }) {
  if (card.type === "tool" || card.type === "tool_use") {
    const toolCard = card as ToolNode;
    if (toolCard.toolName === "Task") {
      return <SubAgentDetail card={toolCard} />;
    }
    if (toolCard.isError) {
      return <ErrorDetail card={toolCard} />;
    }
    return <ToolDetail card={toolCard} />;
  }

  if (card.type === "thinking" || card.type === "text") {
    return <ThinkingDetail card={card} />;
  }

  if (card.type === "complete") {
    return <CompleteDetail card={card} />;
  }

  return null;
}

// === Event Node Detail ===

/**
 * 이벤트 노드(user, intervention, system, result)의 상세 뷰.
 * nodeType에 따라 적절한 레이아웃으로 표시합니다.
 */
function EventNodeDetail({
  data,
}: {
  data: SelectedEventNodeData;
}) {
  if (data.nodeType === "result") {
    return <ResultNodeDetail data={data} />;
  }

  if (data.nodeType === "system") {
    return <SystemNodeDetail data={data} />;
  }

  // user 또는 intervention
  const isUser = data.nodeType === "user";

  return (
    <div className="p-4">
      {/* Type badge */}
      <div className="flex items-center gap-1.5 mb-3">
        <span className="text-sm">{isUser ? "\u{1F464}" : "\u270B"}</span>
        <span
          className={`text-[12px] font-semibold uppercase tracking-[0.05em] ${isUser ? "text-accent-blue" : "text-accent-orange"}`}
        >
          {isUser ? "User Message" : "Intervention"}
        </span>
      </div>

      {/* Label */}
      <div className="mb-3">
        <SectionLabel>From</SectionLabel>
        <div className="text-[14px] text-foreground font-medium">
          {data.label}
        </div>
      </div>

      {/* Full content */}
      <div>
        <SectionLabel>Message</SectionLabel>
        <CodeBlock maxHeight={500}>{data.content || "(empty)"}</CodeBlock>
      </div>
    </div>
  );
}

/** result 노드 상세: 세션 결과 (duration, cost, usage) */
function ResultNodeDetail({ data }: { data: SelectedEventNodeData }) {
  const durationStr = data.durationMs
    ? `${(data.durationMs / 1000).toFixed(1)}s`
    : null;
  const costStr = data.totalCostUsd
    ? `$${data.totalCostUsd.toFixed(4)}`
    : null;
  const hasStats = durationStr || costStr || data.usage;

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-3">
        <span className="w-1.5 h-1.5 rounded-full bg-success" />
        <span className="text-[12px] font-semibold uppercase tracking-[0.05em] text-success">
          Session Complete
        </span>
      </div>

      {/* Stats */}
      {hasStats && (
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2">
          {durationStr && (
            <div>
              <SectionLabel>Duration</SectionLabel>
              <div className="text-[14px] text-foreground font-medium">{durationStr}</div>
            </div>
          )}
          {costStr && (
            <div>
              <SectionLabel>Cost</SectionLabel>
              <div className="text-[14px] text-foreground font-medium">{costStr}</div>
            </div>
          )}
          {data.usage && (
            <div className="col-span-2">
              <SectionLabel>Tokens</SectionLabel>
              <div className="text-[14px] text-foreground font-medium">
                {data.usage.input_tokens.toLocaleString()} in / {data.usage.output_tokens.toLocaleString()} out
              </div>
            </div>
          )}
        </div>
      )}

      {/* Output */}
      {data.content && (
        <div>
          <SectionLabel>Output</SectionLabel>
          <CodeBlock maxHeight={500}>{data.content}</CodeBlock>
        </div>
      )}
    </div>
  );
}

/** system 노드 상세: complete/error 메시지 */
function SystemNodeDetail({ data }: { data: SelectedEventNodeData }) {
  const isError = data.isError;

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-3">
        <span className={`w-1.5 h-1.5 rounded-full ${isError ? "bg-accent-red" : "bg-muted-foreground"}`} />
        <span
          className={`text-[12px] font-semibold uppercase tracking-[0.05em] ${isError ? "text-accent-red" : "text-muted-foreground"}`}
        >
          {isError ? "Error" : data.label || "System"}
        </span>
      </div>

      {/* Content */}
      <div>
        <SectionLabel>{isError ? "Error Message" : "Message"}</SectionLabel>
        <CodeBlock maxHeight={500}>{data.content || "(no details)"}</CodeBlock>
      </div>
    </div>
  );
}

// === DetailView ===

export function DetailView() {
  const selectedCardId = useDashboardStore((s) => s.selectedCardId);
  const selectedEventNodeData = useDashboardStore(
    (s) => s.selectedEventNodeData,
  );
  const tree = useDashboardStore((s) => s.tree);

  const selectedCard: EventTreeNode | null = selectedCardId
    ? findTreeNode(tree, selectedCardId)
    : null;

  const hasSelection = selectedCard || selectedEventNodeData;

  return (
    <div
      data-testid="detail-view"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Content */}
      <ScrollArea className="flex-1">
        {!hasSelection && (
          <div className="p-5 text-center text-muted-foreground text-[13px]">
            Select a node to view details
          </div>
        )}

        {selectedCard && <CardDetail card={selectedCard} />}
        {selectedEventNodeData && !selectedCard && (
          <EventNodeDetail data={selectedEventNodeData} />
        )}
      </ScrollArea>
    </div>
  );
}
