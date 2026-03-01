/**
 * ThinkingDetail - 텍스트/사고 카드 상세 뷰
 *
 * 선택된 텍스트 카드의 전체 내용을 표시합니다.
 * 스트리밍 중인 카드는 펄스 인디케이터를 함께 보여줍니다.
 */

import type { DashboardCard } from "@shared/types";

export function ThinkingDetail({ card }: { card: DashboardCard }) {
  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-base">{"\u{1F4AD}"}</span>
        <div className="text-[11px] text-accent-purple uppercase tracking-[0.05em] font-semibold">
          Thinking
        </div>
        {!card.completed && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-accent-purple">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-purple animate-[pulse_2s_infinite]" />
            Streaming...
          </span>
        )}
      </div>

      {/* Full text content */}
      <pre
        className="text-[13px] text-foreground whitespace-pre-wrap break-words leading-relaxed m-0 font-mono"
      >
        {card.content || "(streaming...)"}
      </pre>

      {/* Character count */}
      {card.content && (
        <div className="text-[10px] text-muted-foreground/60 text-right">
          {card.content.length.toLocaleString()} chars
        </div>
      )}
    </div>
  );
}
