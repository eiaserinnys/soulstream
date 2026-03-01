/**
 * DetailView - 선택된 카드/노드의 상세 정보 패널
 *
 * 카드 타입에 따라 적절한 상세 컴포넌트를 라우팅합니다.
 * - text 카드 → ThinkingDetail
 * - tool 카드 (Task) → SubAgentDetail
 * - tool 카드 (에러) → ErrorDetail
 * - tool 카드 (일반) → ToolDetail
 * - user/intervention 이벤트 노드 → EventNodeDetail
 */

import type { DashboardCard } from "@shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { ThinkingDetail } from "./detail/ThinkingDetail";
import { ToolDetail } from "./detail/ToolDetail";
import { SubAgentDetail } from "./detail/SubAgentDetail";
import { ErrorDetail } from "./detail/ErrorDetail";
import { ToolGroupDetail, type ToolGroupData } from "./detail/ToolGroupDetail";
import { SectionLabel, CodeBlock } from "./detail/shared";
import { ScrollArea } from "./ui/scroll-area";

// === Detail Router ===

/**
 * 카드 타입에 따라 적절한 상세 컴포넌트를 선택합니다.
 *
 * 우선순위:
 * 1. tool + toolName === "Task" → SubAgentDetail
 * 2. tool + isError === true → ErrorDetail
 * 3. tool → ToolDetail
 * 4. text → ThinkingDetail
 */
function CardDetail({ card }: { card: DashboardCard }) {
  if (card.type === "tool") {
    if (card.toolName === "Task") {
      return <SubAgentDetail card={card} />;
    }
    if (card.isError) {
      return <ErrorDetail card={card} />;
    }
    return <ToolDetail card={card} />;
  }

  return <ThinkingDetail card={card} />;
}

// === Event Node Detail ===

/**
 * user/intervention 이벤트 노드의 상세 뷰.
 * 전체 메시지 텍스트를 표시합니다.
 */
function EventNodeDetail({
  data,
}: {
  data: { nodeType: string; label: string; content: string };
}) {
  const isUser = data.nodeType === "user";

  return (
    <div className="p-4">
      {/* Type badge */}
      <div className="flex items-center gap-1.5 mb-3">
        <span className="text-sm">{isUser ? "\u{1F464}" : "\u270B"}</span>
        <span
          className={`text-[11px] font-semibold uppercase tracking-[0.05em] ${isUser ? "text-accent-blue" : "text-accent-orange"}`}
        >
          {isUser ? "User Message" : "Intervention"}
        </span>
      </div>

      {/* Label */}
      <div className="mb-3">
        <SectionLabel>From</SectionLabel>
        <div className="text-[13px] text-foreground font-medium">
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

// === DetailView ===

export function DetailView() {
  const selectedCardId = useDashboardStore((s) => s.selectedCardId);
  const selectedEventNodeData = useDashboardStore(
    (s) => s.selectedEventNodeData,
  );
  const cards = useDashboardStore((s) => s.cards);

  const selectedCard = selectedCardId
    ? cards.find((c) => c.cardId === selectedCardId) ?? null
    : null;

  const hasSelection = selectedCard || selectedEventNodeData;

  return (
    <div
      data-testid="detail-view"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <div className="py-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] flex justify-between items-center">
        <span>Detail</span>
        {selectedCard && (
          <span
            className="text-[10px] text-muted-foreground/60 font-normal normal-case font-mono"
          >
            {selectedCard.cardId}
          </span>
        )}
        {selectedEventNodeData && !selectedCard && (
          <span className="text-[10px] text-muted-foreground/60 font-normal normal-case">
            {selectedEventNodeData.nodeType}
          </span>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {!hasSelection && (
          <div className="p-5 text-center text-muted-foreground text-[13px]">
            Select a node to view details
          </div>
        )}

        {selectedCard && <CardDetail card={selectedCard} />}
        {selectedEventNodeData && !selectedCard && selectedEventNodeData.nodeType === "tool_group" && (
          <ToolGroupDetail data={selectedEventNodeData as ToolGroupData} />
        )}
        {selectedEventNodeData && !selectedCard && selectedEventNodeData.nodeType !== "tool_group" && (
          <EventNodeDetail data={selectedEventNodeData} />
        )}
      </ScrollArea>
    </div>
  );
}
