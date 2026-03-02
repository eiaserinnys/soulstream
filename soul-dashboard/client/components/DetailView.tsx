/**
 * DetailView - 선택된 카드/노드의 상세 정보 패널
 *
 * 카드 타입에 따라 적절한 상세 컴포넌트를 라우팅합니다.
 * - text 카드 → ThinkingDetail
 * - tool 카드 (Task) → SubAgentDetail
 * - tool 카드 (에러) → ErrorDetail
 * - tool 카드 (일반, call 선택) → ToolDetail (Input 포커스)
 * - tool 카드 (일반, result 선택) → ToolDetail (Result 포커스)
 * - user/intervention 이벤트 노드 → EventNodeDetail
 */

import type { DashboardCard } from "@shared/types";
import { useDashboardStore, findTreeNode, treeNodeToCard } from "../stores/dashboard-store";
import { ThinkingDetail } from "./detail/ThinkingDetail";
import { ToolDetail } from "./detail/ToolDetail";
import { SubAgentDetail } from "./detail/SubAgentDetail";
import { ErrorDetail } from "./detail/ErrorDetail";
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
function CardDetail({ card, focusResult }: { card: DashboardCard; focusResult?: boolean }) {
  if (card.type === "tool") {
    if (card.toolName === "Task") {
      return <SubAgentDetail card={card} />;
    }
    if (card.isError) {
      return <ErrorDetail card={card} />;
    }
    return <ToolDetail card={card} focusResult={focusResult} />;
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
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const selectedEventNodeData = useDashboardStore(
    (s) => s.selectedEventNodeData,
  );
  const tree = useDashboardStore((s) => s.tree);

  const selectedCard: DashboardCard | null = selectedCardId
    ? (() => {
        const treeNode = findTreeNode(tree, selectedCardId);
        return treeNode ? treeNodeToCard(treeNode) : null;
      })()
    : null;

  // tool_result 노드를 선택했는지 판정 (nodeId가 "-result"로 끝남)
  const focusResult = selectedNodeId?.endsWith("-result") ?? false;

  const hasSelection = selectedCard || selectedEventNodeData;

  // 상세 헤더에 표시할 타입 라벨
  const headerTypeLabel = selectedCard
    ? focusResult ? "Result" : selectedCard.type === "tool" ? "Tool Call" : selectedCard.type
    : selectedEventNodeData?.nodeType ?? "";

  return (
    <div
      data-testid="detail-view"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header */}
      <div className="py-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] flex justify-between items-center">
        <span>Detail</span>
        {hasSelection && (
          <span
            className="text-[10px] text-muted-foreground/60 font-normal normal-case font-mono"
          >
            {headerTypeLabel}
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

        {selectedCard && <CardDetail card={selectedCard} focusResult={focusResult} />}
        {selectedEventNodeData && !selectedCard && (
          <EventNodeDetail data={selectedEventNodeData} />
        )}
      </ScrollArea>
    </div>
  );
}
