/**
 * ToolGroupDetail - 도구 그룹 노드 상세 뷰
 *
 * 그룹 노드를 클릭했을 때 그룹 내 모든 개별 도구 호출을 목록으로 표시합니다.
 * 각 호출의 입력 파라미터 요약과 에러 여부를 보여줍니다.
 */

import type { DashboardCard } from "@shared/types";
import { SectionLabel } from "./shared";
import { useDashboardStore, findTreeNode, treeNodeToCard } from "../../stores/dashboard-store";
import { cn } from "../../lib/cn";

/** ToolGroupDetail에 전달되는 데이터 타입 (스토어의 selectedEventNodeData에서 추출) */
export interface ToolGroupData {
  nodeType: string;
  label: string;
  content: string;
  groupedCardIds: string[];
  toolName?: string;
  groupCount?: number;
}

export function ToolGroupDetail({ data }: { data: ToolGroupData }) {
  const tree = useDashboardStore((s) => s.tree);
  const groupedCardIds = data.groupedCardIds ?? [];
  const groupedCards = groupedCardIds
    .map((id) => {
      const node = findTreeNode(tree, id);
      return node ? treeNodeToCard(node) : undefined;
    })
    .filter((c): c is DashboardCard => c !== undefined);

  const toolName = data.toolName ?? "unknown";
  const count = data.groupCount ?? groupedCards.length;
  const errorCount = groupedCards.filter((c) => c.isError).length;

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-base">📦</span>
        <div className="text-[11px] text-amber-600 uppercase tracking-[0.05em] font-semibold">
          Tool Group
        </div>
        <span className="ml-auto text-xs text-amber-600 font-bold px-2 py-0.5 rounded bg-amber-600/12">
          ×{count}
        </span>
      </div>

      {/* Tool name */}
      <div>
        <SectionLabel>Tool</SectionLabel>
        <div
          className="text-sm text-foreground font-semibold font-mono"
        >
          {toolName}
        </div>
      </div>

      {/* Summary */}
      <div>
        <SectionLabel>Summary</SectionLabel>
        <div className="text-xs text-muted-foreground">
          {count} calls
          {errorCount > 0 && (
            <span className="text-accent-red ml-2">
              ({errorCount} error{errorCount > 1 ? "s" : ""})
            </span>
          )}
        </div>
      </div>

      {/* Individual calls */}
      <div>
        <SectionLabel>Calls ({groupedCards.length})</SectionLabel>
        <div className="flex flex-col gap-2">
          {groupedCards.map((card, idx) => (
            <div
              key={card.cardId}
              className={cn(
                "rounded-md p-2 px-2.5 border-l-[3px]",
                card.isError
                  ? "bg-destructive/8 border-l-accent-red"
                  : card.completed
                    ? "bg-input border-l-success"
                    : "bg-input border-l-accent-amber",
              )}
            >
              {/* Call header */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] text-muted-foreground">
                  #{idx + 1}
                </span>
                <span
                  className="text-[10px] text-muted-foreground/60 font-mono"
                >
                  {card.cardId}
                </span>
                {card.isError && (
                  <span className="text-[10px] text-accent-red ml-auto">
                    ❌ Error
                  </span>
                )}
                {!card.isError && card.completed && (
                  <span className="text-[10px] text-success ml-auto">
                    ✅
                  </span>
                )}
                {!card.completed && (
                  <span className="text-[10px] text-accent-amber ml-auto">
                    ⏳ running
                  </span>
                )}
              </div>

              {/* Input summary */}
              {card.toolInput && (
                <div
                  className={cn(
                    "text-[11px] text-muted-foreground truncate",
                    card.toolResult !== undefined ? "mb-1" : "",
                    "font-mono",
                  )}
                >
                  {summarizeInput(card.toolInput)}
                </div>
              )}

              {/* Result summary */}
              {card.toolResult !== undefined && (
                <div
                  className={cn(
                    "text-[11px] truncate",
                    card.isError ? "text-destructive-foreground" : "text-muted-foreground",
                    "font-mono",
                  )}
                >
                  → {card.toolResult.length > 80 ? card.toolResult.slice(0, 77) + "..." : card.toolResult}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 입력 파라미터를 한 줄 요약으로 변환 */
function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "(no input)";

  // 주요 필드 우선: file_path, command, pattern, query, prompt, url
  const priorityKeys = ["file_path", "command", "pattern", "query", "prompt", "url"];
  const key = priorityKeys.find((k) => k in input) ?? keys[0];
  const val = input[key];
  const str = typeof val === "string" ? val : JSON.stringify(val);
  const truncated = str && str.length > 60 ? str.slice(0, 57) + "..." : str;
  return `${key}: ${truncated}`;
}
