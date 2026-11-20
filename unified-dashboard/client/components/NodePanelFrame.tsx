import type { ReactNode } from "react";
import { cn } from "@seosoyoung/soul-ui";

/**
 * 노드 탭 카드의 틀. 노드 카드와 중앙 풀 카드가 같은 틀을 쓴다.
 * 틀은 모양만 맡고, 머리와 몸의 내용은 각 카드가 정한다.
 */
export function NodeCardFrame({
  testId,
  dimmed = false,
  children,
}: {
  testId: string;
  dimmed?: boolean;
  children: ReactNode;
}) {
  return <div
    data-testid={testId}
    className={cn(
      "overflow-hidden rounded-[13px] border border-border bg-muted/10",
      dimmed && "opacity-60",
    )}
  >
    {children}
  </div>;
}

/** 카드 머리 한 줄. 누르면 펼친다. */
export function NodeCardHeader({
  testId,
  expanded,
  onClick,
  children,
}: {
  testId?: string;
  expanded: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return <div
    data-testid={testId}
    aria-expanded={expanded}
    className="flex items-center gap-2 px-3 py-2 select-none cursor-pointer hover:bg-muted/30"
    onClick={onClick}
  >
    {children}
  </div>;
}

/** 펼친 카드의 몸. 위 테두리로 머리와 나뉜다. */
export function NodeCardBody({ children }: { children: ReactNode }) {
  return <div className="border-t border-border px-3 py-3">{children}</div>;
}
