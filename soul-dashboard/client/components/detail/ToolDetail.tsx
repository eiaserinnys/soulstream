/**
 * ToolDetail - 도구 호출 카드 상세 뷰
 *
 * 도구 이름, 입력 파라미터, 실행 결과를 상세히 표시합니다.
 * 에러가 아닌 일반 도구 호출에 사용됩니다.
 */

import type { DashboardCard } from "@shared/types";
import { SectionLabel, CodeBlock, safeStringify } from "./shared";

export function ToolDetail({ card }: { card: DashboardCard }) {
  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-base">{"\u{1F527}"}</span>
        <div className="text-[11px] text-accent-amber uppercase tracking-[0.05em] font-semibold">
          Tool Call
        </div>
        {!card.completed && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-accent-amber">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-[pulse_2s_infinite]" />
            Running...
          </span>
        )}
      </div>

      {/* Tool name */}
      <div>
        <SectionLabel>Tool</SectionLabel>
        <div
          className="text-sm text-foreground font-semibold font-mono"
        >
          {card.toolName ?? "unknown"}
        </div>
      </div>

      {/* Tool input */}
      {card.toolInput && (
        <div>
          <SectionLabel>Input</SectionLabel>
          <CodeBlock>{safeStringify(card.toolInput)}</CodeBlock>
        </div>
      )}

      {/* Tool result */}
      {card.toolResult !== undefined && (
        <div>
          <SectionLabel>Result</SectionLabel>
          <CodeBlock>{card.toolResult}</CodeBlock>
        </div>
      )}
    </div>
  );
}
