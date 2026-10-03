import "./v3-folder-board.css";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import type { ReactNode, Ref, MouseEventHandler, AnimationEventHandler } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronDown, ChevronUp, X } from "lucide-react";
export function FolderDocumentOverlay({
  surfaceRef,
  expanded,
  closing = false,
  onAnimationEnd,
  onHeaderMouseDown,
  projectTitle,
  folderTitle,
  onToggleExpanded,
  onClose,
  children,
}: {
  surfaceRef?: Ref<HTMLDivElement>;
  expanded: boolean;
  closing?: boolean;
  onAnimationEnd?: AnimationEventHandler<HTMLElement>;
  onHeaderMouseDown?: MouseEventHandler<HTMLElement>;
  projectTitle: string;
  folderTitle: string;
  onToggleExpanded(): void;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <LiquidGlassCard
      ref={surfaceRef}
      webglSurface
      cornerRadius={24}
      className={`v3-folder-board-document-overlay${expanded ? " is-expanded" : ""}${closing ? " is-closing" : ""}`}
      data-testid="v3-folder-board-document-overlay"
      data-state={closing ? "closing" : "open"}
      onAnimationEnd={onAnimationEnd}
    >
      <header className="v3-chat-header" onMouseDown={onHeaderMouseDown}>
        <div>
          <small>
            {projectTitle} › {folderTitle}
          </small>
          <strong>마크다운 문서</strong>
        </div>
        <DashboardIconCap
          label={expanded ? "문서 편집기 높이 축소" : "문서 편집기 높이 확장"}
          aria-pressed={expanded}
          data-testid="v3-folder-board-document-overlay-expand"
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          )}
        </DashboardIconCap>
        <DashboardIconCap
          label="문서 편집기 닫기"
          data-testid="v3-folder-board-document-overlay-close"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </header>
      <div className="v3-board-document-content">{children}</div>
    </LiquidGlassCard>
  );
}
