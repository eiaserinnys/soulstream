/**
 * ErrorDetail - 에러 카드 상세 뷰
 *
 * 도구 실행 중 에러가 발생한 카드의 상세 정보를 표시합니다.
 * 에러 메시지를 강조하고, 도구 이름과 입력 정보도 함께 보여줍니다.
 */

import type { DashboardCard } from "@shared/types";
import { SectionLabel, CodeBlock, safeStringify } from "./shared";

export function ErrorDetail({ card }: { card: DashboardCard }) {
  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-base">{"\u274C"}</span>
        <div className="text-[11px] text-accent-red uppercase tracking-[0.05em] font-semibold">
          Error
        </div>
      </div>

      {/* Error banner */}
      <div className="p-2.5 px-3 rounded-md bg-destructive/10 border border-destructive/20">
        <div className="text-xs text-destructive-foreground font-semibold mb-1">
          {card.toolName ?? "Tool"} failed
        </div>
        <pre
          className="text-xs text-destructive-foreground whitespace-pre-wrap break-words leading-normal m-0 font-mono"
        >
          {card.toolResult || "(no error message)"}
        </pre>
      </div>

      {/* Tool info */}
      <div>
        <SectionLabel>Tool</SectionLabel>
        <div
          className="text-sm text-foreground font-semibold font-mono"
        >
          {card.toolName ?? "unknown"}
        </div>
      </div>

      {/* Tool input that caused the error */}
      {card.toolInput && (
        <div>
          <SectionLabel>Input</SectionLabel>
          <CodeBlock maxHeight={200}>{safeStringify(card.toolInput)}</CodeBlock>
        </div>
      )}
    </div>
  );
}
