/**
 * ToolDetail - 도구 호출 카드 상세 뷰
 *
 * 도구 이름, 입력 파라미터, 실행 결과를 상세히 표시합니다.
 * 입력/결과 영역은 사용 가능한 세로 공간을 최대한 활용합니다.
 */

import { useRef, useState, useLayoutEffect } from "react";
import type { ToolNode } from "@shared/types";
import { SectionLabel, CodeBlock, safeStringify } from "./shared";

interface ToolDetailProps {
  card: ToolNode;
}

/** Result 영역의 최소 높이 */
const RESULT_MIN_HEIGHT = 200;
/** 상단/하단 패딩 (p-4 = 16px) */
const CONTAINER_PADDING = 16;

export function ToolDetail({ card }: ToolDetailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [resultMinHeight, setResultMinHeight] = useState(RESULT_MIN_HEIGHT);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const result = resultRef.current;
    if (!container || !result) return;

    const updateHeight = () => {
      // ScrollArea viewport의 높이
      const scrollViewport = container.closest('[data-slot="scroll-area-viewport"]');
      const viewportHeight = scrollViewport?.clientHeight ?? 0;
      // Result 영역의 시작 위치 (컨테이너 상단 기준)
      const resultTop = result.offsetTop;
      // Result label 높이 (~15px)
      const resultLabelHeight = 15;
      // 남은 공간 = viewport - resultTop - label - 하단 패딩
      const available = viewportHeight - resultTop - resultLabelHeight - CONTAINER_PADDING;
      setResultMinHeight(Math.max(RESULT_MIN_HEIGHT, available));
    };

    // 초기 측정은 다음 프레임에서 (레이아웃 완료 후)
    requestAnimationFrame(updateHeight);

    const resizeObserver = new ResizeObserver(updateHeight);
    const scrollViewport = container.closest('[data-slot="scroll-area-viewport"]');
    if (scrollViewport) {
      resizeObserver.observe(scrollViewport);
    }

    return () => resizeObserver.disconnect();
  }, [card]);

  return (
    <div ref={containerRef} className="p-4 flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-base">{"\u{1F527}"}</span>
        <div className="text-[11px] uppercase tracking-[0.05em] font-semibold text-accent-amber">
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
      <div className="shrink-0">
        <SectionLabel>Tool</SectionLabel>
        <div
          className="text-sm text-foreground font-semibold font-mono"
        >
          {card.toolName}
        </div>
      </div>

      {/* Input (짧은 높이) */}
      {card.toolInput && (
        <div className="shrink-0">
          <SectionLabel>Input</SectionLabel>
          <CodeBlock maxHeight={80}>{safeStringify(card.toolInput)}</CodeBlock>
        </div>
      )}

      {/* Result (남은 공간 채움) */}
      {card.toolResult !== undefined && (
        <div ref={resultRef} className="shrink-0">
          <SectionLabel>Result</SectionLabel>
          <CodeBlock
            variant={card.isError ? "error" : "default"}
            maxHeight={undefined}
            style={{ minHeight: resultMinHeight }}
          >
            {card.toolResult}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
