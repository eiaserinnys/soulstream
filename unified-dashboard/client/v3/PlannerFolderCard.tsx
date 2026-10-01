import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { DashboardIconCap, type SessionSummary } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { MoreHorizontal, Star } from "lucide-react";

import {
  latestRun,
  plannerStatusPresentation,
} from "./planner-model";
import type { PlannerFolder } from "./planner-data";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { buildFolderContextMenuActions } from "./context-menu-model";
import {
  singleLinePreview,
  TASK_TITLE_PREVIEW_LENGTH,
} from "./session-preview";
import { useFolderStar } from "./use-folder-star";
import {
  sessionPresentationStatus,
  type SessionNodeConnectivity,
} from "./session-node-connectivity";
import "./v3-content-boundary.css";
import { StatusChip } from "./StatusChip";

type PlannerFolderCardProps = {
  task: PlannerFolder;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  isInToday: boolean;
  onOpen(): void;
  onComplete(): Promise<void>;
  onToggleToday(): Promise<void>;
  onMoveToParent(): void;
  navigationLabel?: string;
  onRename?(): void;
  onArchive?(): void;
};

export function PlannerFolderCard(props: PlannerFolderCardProps) {
  const folderStar = useFolderStar(props.task.page);
  return <PlannerFolderCardView {...props} folderStar={folderStar} />;
}

/** Same operational markup, with state and mutation callbacks supplied by its owner. */
export function PlannerFolderCardView({
  task,
  sessions,
  nodeConnectivity,
  isInToday,
  onOpen,
  onComplete,
  onToggleToday,
  onMoveToParent,
  navigationLabel,
  onRename,
  onArchive,
  folderStar,
}: PlannerFolderCardProps & { folderStar: ReturnType<typeof useFolderStar> }) {
  const [contextMenu, setContextMenu] = useState<V3ContextMenuTarget | null>(null);
  const status = plannerStatusPresentation(task.status);
  const run = latestRun(task.sessionIds, sessions);
  const runStatus = run ? sessionPresentationStatus(run.session, nodeConnectivity) : null;
  const showAssignee = task.assignee !== "담당 미지정" && task.assignee !== "담당 미확인";
  const showRun = runStatus === "running" || runStatus === "offline";
  const runState = runStatus === "offline" ? "노드 오프라인" : "실행 중";
  const openFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  const openContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <LiquidGlassCard
      webglSurface
      cornerRadius={18}
      className={`v3-task-card v3-task-card--${task.status}${onRename ? " v3-task-card--managed" : ""} rounded-[18px] border border-white/8 shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={openFromKeyboard}
      onContextMenu={openContextMenu}
      data-testid={`v3-task-${task.page.id}`}
    >
      <div className="v3-task-main">
        <div className="v3-task-kicker">
          <StatusChip label={navigationLabel ?? (task.status === "in_progress" || task.status === "review" ? `카드 집계 · ${status.label}` : `폴더 ${task.status === "open" ? "열림" : status.label}`)} tone={navigationLabel ? undefined : task.status}/>
        </div>
        <h3
          className="v3-text-clamp-2"
          aria-label={task.page.title}
          title={task.page.title}
        >
          {singleLinePreview(task.page.title, TASK_TITLE_PREVIEW_LENGTH)}
        </h3>
        {showAssignee ? (
          <div className="v3-task-meta">
            <span className="v3-agent-dot" aria-hidden="true">
              {task.assignee.slice(0, 1)}
            </span>
            <span>{task.assignee}</span>
          </div>
        ) : null}
      </div>
      {showRun && run ? <div className="v3-task-state">
          <StatusChip label={`세션 #${run.number} ${runState}`} tone={runStatus ?? undefined}/>
      </div> : null}
      <div className="v3-task-star-slot">
        {onRename ? <DashboardIconCap
          label={`${task.page.title} 관리 메뉴`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setContextMenu({ x: rect.left, y: rect.bottom });
          }}
        ><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></DashboardIconCap> : null}
        <DashboardIconCap
          className="v3-task-star-toggle"
          label={`${task.page.title} ${folderStar.starred ? "별표 해제" : "별표 추가"}`}
          aria-pressed={folderStar.starred}
          disabled={folderStar.pending}
          onClick={(event) => { event.stopPropagation(); void folderStar.toggle(); }}
        >
          <Star className="h-4 w-4" fill={folderStar.starred ? "currentColor" : "none"} aria-hidden="true" />
        </DashboardIconCap>
      </div>
      <V3ContextMenu
        target={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={buildFolderContextMenuActions({
          starred: folderStar.starred,
          completed: task.status === "completed",
          inToday: isInToday,
        }, {
          open: onOpen,
          copyId: () => navigator.clipboard.writeText(task.folderId),
          toggleStar: folderStar.toggle,
          moveToParent: onMoveToParent,
          complete: onComplete,
          toggleToday: onToggleToday,
          rename: onRename,
          archive: onArchive,
        })}
      />
    </LiquidGlassCard>
  );
}
