import { Loader2, MoreVertical, Pin } from "lucide-react";

import type { SessionSummary, TaskItem, TaskStatus } from "../shared";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import type { TaskTreeRow } from "./task-tree-layout";
import {
  AgentAvatar,
  LinkedSessionRuntimeIndicator,
  STATUS_META,
  TaskStatusLineOverlay,
  TaskTreeLines,
} from "./TaskTreeParts";

interface TaskTreeListPanelProps {
  loading: boolean;
  tasks: TaskItem[];
  rows: TaskTreeRow[];
  selectedTaskId: string | null;
  pendingTaskId: string | null;
  sessionById: ReadonlyMap<string, SessionSummary>;
  nextStatus: Record<TaskStatus, TaskStatus>;
  onSelectTask: (task: TaskItem) => void;
  onNavigateTask: (task: TaskItem) => void;
  onCycleStatus: (task: TaskItem) => void;
  onContextMenu: (x: number, y: number, taskId: string) => void;
}

export function TaskTreeListPanel({
  loading,
  tasks,
  rows,
  selectedTaskId,
  pendingTaskId,
  sessionById,
  nextStatus,
  onSelectTask,
  onNavigateTask,
  onCycleStatus,
  onContextMenu,
}: TaskTreeListPanelProps) {
  if (loading && tasks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        No task items
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <TaskRowItem
            key={row.task.id}
            row={row}
            selected={selectedTaskId === row.task.id}
            pending={pendingTaskId === row.task.id}
            sessionById={sessionById}
            nextStatus={nextStatus}
            onSelectTask={onSelectTask}
            onNavigateTask={onNavigateTask}
            onCycleStatus={onCycleStatus}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

function TaskRowItem({
  row,
  selected,
  pending,
  sessionById,
  nextStatus,
  onSelectTask,
  onNavigateTask,
  onCycleStatus,
  onContextMenu,
}: {
  row: TaskTreeRow;
  selected: boolean;
  pending: boolean;
  sessionById: ReadonlyMap<string, SessionSummary>;
  nextStatus: Record<TaskStatus, TaskStatus>;
  onSelectTask: (task: TaskItem) => void;
  onNavigateTask: (task: TaskItem) => void;
  onCycleStatus: (task: TaskItem) => void;
  onContextMenu: (x: number, y: number, taskId: string) => void;
}) {
  const { task } = row;
  const StatusIcon = STATUS_META[task.status].icon;
  const navigationDisabled = !(task.navigationSessionId ?? task.linkedSessionId);
  const linkedSession = task.linkedSessionId
    ? sessionById.get(task.linkedSessionId)
    : undefined;
  const portraitUrl = linkedSession?.agentPortraitUrl ?? null;
  const verifiedDone = task.status === "verified_done";

  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-2 transition-colors",
        row.depth === 0 ? "min-h-[62px]" : "min-h-[52px]",
        navigationDisabled ? "text-muted-foreground" : "hover:bg-muted/45",
        selected && "bg-muted/55",
        verifiedDone && "opacity-70",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelectTask(task);
        onContextMenu(event.clientX, event.clientY, task.id);
      }}
    >
      <TaskTreeLines row={row} />

      <div className="relative flex w-8 shrink-0 self-stretch items-center justify-center">
        <TaskStatusLineOverlay row={row} />
        <Button
          variant="ghost"
          size="icon"
          className="relative z-10 h-8 w-8 shrink-0"
          disabled={pending}
          title={`Set ${nextStatus[task.status]}`}
          onClick={() => void onCycleStatus(task)}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <StatusIcon className={cn("h-4 w-4", STATUS_META[task.status].className)} />
          )}
        </Button>
      </div>

      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        disabled={navigationDisabled}
        onClick={() => onNavigateTask(task)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {task.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />}
          <span
            className={cn(
              "font-semibold truncate",
              row.depth === 0 ? "text-[15px] leading-5" : "text-[13px] leading-4",
            )}
          >
            {task.title}
          </span>
          <span
            className={cn(
              "text-muted-foreground shrink-0",
              row.depth === 0 ? "text-[11px] leading-4" : "text-[10px] leading-4",
            )}
          >
            {STATUS_META[task.status].label}
          </span>
        </div>
        {(task.acceptanceCriteria || task.description) && (
          <div
            className={cn(
              "text-muted-foreground truncate",
              row.depth === 0 ? "text-xs leading-4" : "text-[11px] leading-4",
            )}
          >
            {task.acceptanceCriteria || task.description}
          </div>
        )}
      </button>

      <LinkedSessionRuntimeIndicator status={linkedSession?.status} />
      <AgentAvatar portraitUrl={portraitUrl} />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 opacity-70 group-hover:opacity-100"
        title="Task menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onSelectTask(task);
          onContextMenu(rect.right, rect.bottom, task.id);
        }}
      >
        <MoreVertical className="h-4 w-4" />
      </Button>
    </div>
  );
}
