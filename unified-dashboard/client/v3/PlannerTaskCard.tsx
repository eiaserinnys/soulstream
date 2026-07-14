import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";

import {
  latestRun,
  plannerStatusPresentation,
} from "./planner-model";
import type { PlannerTask } from "./planner-data";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";

export function PlannerTaskCard({
  task,
  sessions,
  onOpen,
  onComplete,
  onToggleToday,
}: {
  task: PlannerTask;
  sessions: readonly SessionSummary[];
  onOpen(): void;
  onComplete(): Promise<void>;
  onToggleToday(): Promise<void>;
}) {
  const [contextMenu, setContextMenu] = useState<V3ContextMenuTarget | null>(null);
  const status = plannerStatusPresentation(task.status);
  const run = latestRun(task.sessionIds, sessions);
  const runState = run?.session.status === "running" ? "실행 중" : run ? "완료" : "시작 전";
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
          <span className="v3-task-id">{task.runbookId.slice(0, 8)}</span>
        </div>
        <h3>{task.page.title}</h3>
        <div className="v3-task-meta">
          <span className="v3-agent-dot" aria-hidden="true">
            {task.assignee.slice(0, 1)}
          </span>
          <span>{task.assignee}</span>
          <span>컨텍스트 {task.contextCount}</span>
        </div>
      </div>
      <div className="v3-task-side">
        <span className="v3-run-line">
          {run ? `run #${run.number} ${runState}` : "run 0 · 시작 전"}
          {run?.session.status === "running" ? <i aria-label="실행 중" /> : null}
        </span>
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
        actions={[
          { label: "업무 열기", onSelect: onOpen },
          { label: "업무 페이지 ID 복사", onSelect: () => navigator.clipboard.writeText(task.page.id) },
          { label: "완료 처리", onSelect: onComplete, disabled: task.status === "completed", separatorBefore: true },
          { label: "오늘 플래너에 추가·제거", onSelect: onToggleToday },
        ]}
      />
    </LiquidGlassCard>
  );
}
