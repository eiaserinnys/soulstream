import { useTranslation } from "react-i18next";
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
      "overflow-hidden rounded-floor border border-border bg-muted/10",
      dimmed && "opacity-60",
    )}
  >
    {children}
  </div>;
}

/**
 * 카드 머리 한 줄. 줄을 누르면 마우스로 펼치고, 끝의 ▲▼는 키보드로도 펼치는 단추다.
 * 머리 div를 role=button으로 만들지 않는다(노드 카드 머리 안의 「사용량 새로 고침」 단추가
 * 단추 안에 들어가므로). 단추는 전파를 막아 줄 클릭과 겹치지 않는다.
 */
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
  const { t } = useTranslation();
  return <div
    data-testid={testId}
    aria-expanded={expanded}
    className="flex items-center gap-2 px-3 py-2 select-none cursor-pointer hover:bg-muted/30"
    onClick={onClick}
  >
    {children}
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? t("accounts.nodes.collapse") : t("accounts.nodes.expand")}
      className="shrink-0 inline-flex items-center rounded-full text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {/* 층 밖 `.v3-shell button` 규칙이 단추 글자를 머리 글자(16px/24px)로 키운다.
          글리프를 text-xs span이 그려야 접힌 머리 높이와 글자 크기가 main과 같다(카드 #1734). */}
      <span className="text-xs">{expanded ? "▲" : "▼"}</span>
    </button>
  </div>;
}

/** 펼친 카드의 몸. 위 테두리로 머리와 나뉜다. */
export function NodeCardBody({ children }: { children: ReactNode }) {
  return <div className="border-t border-border px-3 py-3">{children}</div>;
}
