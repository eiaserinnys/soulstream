/**
 * ToolDetail - 도구 호출 카드 상세 뷰
 *
 * 도구 이름, 입력 파라미터, 실행 결과를 상세히 표시합니다.
 * Input:Result 영역은 33%:67% 비율로 사용 가능한 세로 공간을 분배합니다.
 * 양쪽 모두 하한 크기가 있어서 영역이 모자라면 스크롤됩니다.
 */

import { useRef, useState, useLayoutEffect } from "react";
import type { ToolNode } from "@shared/types";
import { SectionLabel, CodeBlock, safeStringify } from "./shared";

interface ToolDetailProps {
  card: ToolNode;
}

/** Input 영역의 최소 높이 */
const INPUT_MIN_HEIGHT = 100;
/** Result 영역의 최소 높이 */
const RESULT_MIN_HEIGHT = 150;
/** 상단/하단 패딩 (p-4 = 16px) */
const CONTAINER_PADDING = 16;
/** Input:Result 비율에서 Input이 차지하는 비율 */
const INPUT_RATIO = 0.33;

export function ToolDetail({ card }: ToolDetailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [inputMaxHeight, setInputMaxHeight] = useState(INPUT_MIN_HEIGHT);
  const [resultMaxHeight, setResultMaxHeight] = useState(RESULT_MIN_HEIGHT);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateHeight = () => {
      const scrollViewport = container.closest('[data-slot="scroll-area-viewport"]');
      const viewportHeight = scrollViewport?.clientHeight ?? 0;

      // content 영역의 시작 Y 좌표를 측정 (input 또는 result 중 먼저 있는 것)
      const firstContentRef = inputRef.current ?? resultRef.current;
      if (!firstContentRef) return;

      const contentStartY = firstContentRef.offsetTop;
      // 섹션 라벨 높이 (~18px with 12px font) x 표시되는 섹션 수
      const sectionLabelHeight = 18;
      const hasInput = !!inputRef.current;
      const hasResult = !!resultRef.current;
      const sectionCount = (hasInput ? 1 : 0) + (hasResult ? 1 : 0);
      // gap-3 = 12px between sections
      const gapHeight = sectionCount > 0 ? (sectionCount - 1) * 12 : 0;

      // 사용 가능한 총 공간
      const available =
        viewportHeight - contentStartY - (sectionCount * sectionLabelHeight) - gapHeight - CONTAINER_PADDING;

      if (hasInput && hasResult) {
        // 33:67 비율로 분배
        const inputAlloc = Math.max(INPUT_MIN_HEIGHT, available * INPUT_RATIO);
        const resultAlloc = Math.max(RESULT_MIN_HEIGHT, available * (1 - INPUT_RATIO));
        setInputMaxHeight(inputAlloc);
        setResultMaxHeight(resultAlloc);
      } else if (hasInput) {
        setInputMaxHeight(Math.max(INPUT_MIN_HEIGHT, available));
      } else if (hasResult) {
        setResultMaxHeight(Math.max(RESULT_MIN_HEIGHT, available));
      }
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
        <div className="text-[12px] uppercase tracking-[0.05em] font-semibold text-accent-amber">
          Tool Call
        </div>
        {!card.completed && (
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-accent-amber">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-[pulse_2s_infinite]" />
            Running...
          </span>
        )}
      </div>

      {/* Tool name */}
      <div className="shrink-0">
        <SectionLabel>Tool</SectionLabel>
        <div className="text-[15px] text-foreground font-semibold font-mono">
          {card.toolName}
        </div>
      </div>

      {/* Input (33% of available space) */}
      {card.toolInput && (
        <div ref={inputRef} className="shrink-0">
          <SectionLabel>Input</SectionLabel>
          <CodeBlock maxHeight={inputMaxHeight}>
            {safeStringify(card.toolInput)}
          </CodeBlock>
        </div>
      )}

      {/* Result (67% of available space) */}
      {card.toolResult !== undefined && (
        <div ref={resultRef} className="shrink-0">
          <SectionLabel>Result</SectionLabel>
          <CodeBlock
            variant={card.isError ? "error" : "default"}
            maxHeight={resultMaxHeight}
            style={{ minHeight: RESULT_MIN_HEIGHT }}
          >
            {card.toolResult}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
