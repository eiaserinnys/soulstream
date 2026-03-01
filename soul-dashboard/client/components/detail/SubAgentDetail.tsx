/**
 * SubAgentDetail - 서브 에이전트 (Task) 카드 상세 뷰
 *
 * Task 도구 호출의 상세 정보를 표시합니다.
 * description, prompt, subagent_type 등의 필드를 분리하여 보여줍니다.
 */

import type { DashboardCard } from "@shared/types";
import { SectionLabel, CodeBlock } from "./shared";

export function SubAgentDetail({ card }: { card: DashboardCard }) {
  const input = card.toolInput ?? {};
  const description = (input.description as string) ?? "";
  const prompt = (input.prompt as string) ?? "";
  const subagentType = (input.subagent_type as string) ?? "unknown";

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-base">{"\u{1F916}"}</span>
        <div className="text-[11px] text-accent-blue uppercase tracking-[0.05em] font-semibold">
          Sub-Agent
        </div>
        {!card.completed && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-accent-blue">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-[pulse_2s_infinite]" />
            Running...
          </span>
        )}
      </div>

      {/* Agent type badge */}
      <div>
        <SectionLabel>Agent Type</SectionLabel>
        <span
          className="inline-block px-2 py-0.5 rounded bg-accent-blue/15 text-info-foreground text-xs font-semibold font-mono"
        >
          {subagentType}
        </span>
      </div>

      {/* Description */}
      {description && (
        <div>
          <SectionLabel>Description</SectionLabel>
          <div className="text-[13px] text-foreground leading-normal">
            {description}
          </div>
        </div>
      )}

      {/* Prompt */}
      {prompt && (
        <div>
          <SectionLabel>Prompt</SectionLabel>
          <CodeBlock>{prompt}</CodeBlock>
        </div>
      )}

      {/* Result (if completed) */}
      {card.toolResult !== undefined && (
        <div>
          <SectionLabel>{card.isError ? "Error" : "Result"}</SectionLabel>
          <CodeBlock variant={card.isError ? "error" : "default"}>
            {card.toolResult}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
