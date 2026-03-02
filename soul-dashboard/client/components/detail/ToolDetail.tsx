/**
 * ToolDetail - 도구 호출 카드 상세 뷰
 *
 * 도구 이름, 입력 파라미터, 실행 결과를 상세히 표시합니다.
 * focusResult=true일 때 결과에 포커스 (Result 노드 클릭 시).
 * 입력/결과 영역은 사용 가능한 세로 공간을 최대한 활용합니다.
 */

import type { DashboardCard } from "@shared/types";
import { SectionLabel, CodeBlock, safeStringify } from "./shared";

interface ToolDetailProps {
  card: DashboardCard;
  /** true면 Result에 포커스 (헤더가 "Result"로 표시됨) */
  focusResult?: boolean;
}

export function ToolDetail({ card, focusResult }: ToolDetailProps) {
  const isResult = focusResult && card.toolResult !== undefined;

  return (
    <div className="p-4 flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-base">
          {isResult
            ? card.isError ? "\u274C" : "\u2705"
            : "\u{1F527}"}
        </span>
        <div className={`text-[11px] uppercase tracking-[0.05em] font-semibold ${
          isResult
            ? card.isError ? "text-accent-red" : "text-success"
            : "text-accent-amber"
        }`}>
          {isResult ? (card.isError ? "Error" : "Result") : "Tool Call"}
        </div>
        {!card.completed && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-accent-amber">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-[pulse_2s_infinite]" />
            Running...
          </span>
        )}
      </div>

      {/* Tool name */}
      <div className="shrink-0">
        <SectionLabel>Tool</SectionLabel>
        <div
          className="text-sm text-foreground font-semibold font-mono"
        >
          {card.toolName ?? "unknown"}
        </div>
      </div>

      {/* Result-focused: 결과를 먼저, 입력을 축소하여 표시 */}
      {isResult ? (
        <>
          {/* Result (주 영역) */}
          <div className="flex-1 min-h-0 flex flex-col">
            <SectionLabel>Result</SectionLabel>
            <CodeBlock
              variant={card.isError ? "error" : "default"}
              maxHeight={undefined}
              className="flex-1"
            >
              {card.toolResult}
            </CodeBlock>
          </div>

          {/* Input (축소) */}
          {card.toolInput && (
            <div className="shrink-0">
              <SectionLabel>Input</SectionLabel>
              <CodeBlock maxHeight={120}>{safeStringify(card.toolInput)}</CodeBlock>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Input (주 영역) */}
          {card.toolInput && (
            <div className="flex-1 min-h-0 flex flex-col">
              <SectionLabel>Input</SectionLabel>
              <CodeBlock maxHeight={undefined} className="flex-1">
                {safeStringify(card.toolInput)}
              </CodeBlock>
            </div>
          )}

          {/* Result */}
          {card.toolResult !== undefined && (
            <div className="flex-1 min-h-0 flex flex-col">
              <SectionLabel>Result</SectionLabel>
              <CodeBlock
                variant={card.isError ? "error" : "default"}
                maxHeight={undefined}
                className="flex-1"
              >
                {card.toolResult}
              </CodeBlock>
            </div>
          )}
        </>
      )}
    </div>
  );
}
