import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { Button, type SessionSummary } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";

import {
  latestRun,
  plannerStatusPresentation,
} from "./planner-model";
import type { PlannerTask } from "./planner-data";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { buildTaskContextMenuActions } from "./context-menu-model";
import {
  singleLinePreview,
  TASK_TITLE_PREVIEW_LENGTH,
} from "./session-preview";
import { useTaskStar } from "./use-task-star";
import {
  sessionPresentationStatus,
  type SessionNodeConnectivity,
} from "./session-node-connectivity";
import "./v3-content-boundary.css";

export function PlannerTaskCard({
  task,
  sessions,
  nodeConnectivity,
  isInToday,
  onOpen,
  onComplete,
  onToggleToday,
  onMoveToProject,
}: {
  task: PlannerTask;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  isInToday: boolean;
  onOpen(): void;
  onComplete(): Promise<void>;
  onToggleToday(): Promise<void>;
  onMoveToProject(): void;
}) {
  const [contextMenu, setContextMenu] = useState<V3ContextMenuTarget | null>(null);
  const taskStar = useTaskStar(task.page);
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
      className={`v3-task-card v3-task-card--${task.status} rounded-[18px] border border-white/8 shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={openFromKeyboard}
      onContextMenu={openContextMenu}
      data-testid={`v3-task-${task.page.id}`}
    >
      <div className="v3-task-main">
        <div className="v3-task-kicker">
          <span className={`v3-status-chip v3-status-chip--${task.status}`}>
            <span aria-hidden="true">{status.icon}</span> {status.label}
          </span>
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
      <div className="v3-task-side">
        <Button
          variant="ghost"
          size="icon-sm"
          className="v3-task-star-toggle"
          aria-label={`${task.page.title} ${taskStar.starred ? "별표 해제" : "별표 추가"}`}
          aria-pressed={taskStar.starred}
          disabled={taskStar.pending}
          onClick={(event) => { event.stopPropagation(); void taskStar.toggle(); }}
        >
          {taskStar.starred ? "★" : "☆"}
        </Button>
        {showRun && run ? (
          <span className="v3-run-line">
            {`세션 #${run.number} ${runState}`}
            {runStatus === "running" ? <i aria-label="실행 중" /> : null}
          </span>
        ) : null}
        {task.progress === null ? null : (
          <span
            className="v3-progress"
            role="progressbar"
            aria-label="런북 진행률"
            aria-valuenow={task.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${task.progress}%` }} />
          </span>
        )}
      </div>
      <V3ContextMenu
        target={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={buildTaskContextMenuActions({
          starred: taskStar.starred,
          completed: task.status === "completed",
          inToday: isInToday,
        }, {
          open: onOpen,
          copyId: () => navigator.clipboard.writeText(task.page.id),
          toggleStar: taskStar.toggle,
          moveToProject: onMoveToProject,
          complete: onComplete,
          toggleToday: onToggleToday,
        })}
      />
    </LiquidGlassCard>
  );
}
