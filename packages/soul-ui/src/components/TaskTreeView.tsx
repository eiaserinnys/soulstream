import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ListChecks,
  Loader2,
  MoreVertical,
  Pin,
  Plus,
  Settings,
} from "lucide-react";

import type { SessionSummary, TaskItem, TaskListResponse, TaskStatus } from "../shared";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import {
  buildTaskStreamUrl,
  buildTaskTreeRows,
  resolveTaskNavigationSummary,
  resolveTaskTreeHeaderAction,
} from "./task-tree-layout";
import { createTaskStreamSubscribe } from "./task-stream-subscribe";
import {
  AgentAvatar,
  LinkedSessionRuntimeIndicator,
  STATUS_META,
  TaskContextMenu,
  TaskStatusLineOverlay,
  TaskTreeLines,
} from "./TaskTreeParts";

const HIDE_COMPLETED_STORAGE_KEY = "soulstream:task-tree:hide-completed:v1";

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  open: "in_progress",
  reopened: "in_progress",
  in_progress: "agent_done",
  agent_done: "verified_done",
  verified_done: "reopened",
  blocked: "reopened",
  cancelled: "reopened",
};

export interface TaskTreeViewProps {
  sessions?: SessionSummary[];
  onNewSession?: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  taskId: string;
}

export function TaskTreeView({ sessions = [], onNewSession }: TaskTreeViewProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hideCompleted, setHideCompleted] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY) === "1";
  });

  const lastTaskEventIdRef = useRef<string | undefined>(undefined);
  const taskStreamInstanceIdRef = useRef<string | undefined>(undefined);

  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const session of sessions) {
      map.set(session.agentSessionId, session);
    }
    return map;
  }, [sessions]);

  const headerAction = useMemo(
    () => resolveTaskTreeHeaderAction(onNewSession),
    [onNewSession],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, hideCompleted ? "1" : "0");
  }, [hideCompleted]);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/tasks?includeArchived=false&limit=1000");
      if (!response.ok) {
        throw new Error(`/api/tasks returned ${response.status}`);
      }
      const data = (await response.json()) as TaskListResponse;
      setTasks(data.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const updateLastEventId = (event: MessageEvent) => {
      if (event.lastEventId) lastTaskEventIdRef.current = event.lastEventId;
    };

    return createTaskStreamSubscribe({
      buildUrl: () =>
        buildTaskStreamUrl(lastTaskEventIdRef.current, taskStreamInstanceIdRef.current),
      onStatusChange: (status) => {
        if (status === "error") {
          setError("Task stream disconnected; retrying automatically.");
          return;
        }
        if (status === "connected") setError(null);
      },
      onEvent: (eventType, data, event) => {
        if (eventType === "stream_meta") {
          const instanceId = typeof data.instance_id === "string" ? data.instance_id : undefined;
          if (
            instanceId &&
            taskStreamInstanceIdRef.current &&
            taskStreamInstanceIdRef.current !== instanceId
          ) {
            void refresh();
            lastTaskEventIdRef.current = String(data.latest_id ?? 0);
          }
          if (instanceId) taskStreamInstanceIdRef.current = instanceId;
          return;
        }

        if (eventType === "task_list") {
          if (Array.isArray(data.tasks)) setTasks(data.tasks as TaskItem[]);
          setLoading(false);
          return;
        }

        if (eventType === "task_changed") {
          updateLastEventId(event);
          void refresh();
          return;
        }

        if (eventType === "replay_gap") {
          lastTaskEventIdRef.current = String(data.latest_id ?? 0);
          void refresh();
        }
      },
    });
  }, [refresh]);

  const rows = useMemo(
    () => buildTaskTreeRows(tasks, { hideCompleted }),
    [hideCompleted, tasks],
  );
  const contextTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;

  const actorSessionIdFor = useCallback(
    (task: TaskItem) =>
      activeSessionKey ?? task.navigationSessionId ?? task.linkedSessionId ?? task.createdFromSessionId,
    [activeSessionKey],
  );

  const navigateToTask = useCallback(
    (task: TaskItem) => {
      const sessionId = task.navigationSessionId ?? task.linkedSessionId;
      if (!sessionId) return;
      setActiveSession(sessionId);
      setActiveSessionSummary(resolveTaskNavigationSummary(sessionById, sessionId));
      setFocusEventId(task.navigationEventId ?? null);
      setActiveTab("chat");
    },
    [sessionById, setActiveSession, setActiveSessionSummary, setActiveTab, setFocusEventId],
  );

  const mutateTask = useCallback(
    async (
      task: TaskItem,
      path: string,
      body: Record<string, unknown>,
    ) => {
      const actorSessionId = actorSessionIdFor(task);
      if (!actorSessionId) return;
      setPendingTaskId(task.id);
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: actorSessionId,
            expectedVersion: task.version,
            ...body,
          }),
        });
        if (!response.ok) {
          throw new Error(`/api/tasks/${task.id}${path} returned ${response.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingTaskId(null);
        setContextMenu(null);
      }
    },
    [actorSessionIdFor, refresh],
  );

  const setTaskStatus = useCallback(
    (task: TaskItem, status: TaskStatus) =>
      mutateTask(task, "/status", { status }),
    [mutateTask],
  );
  const holdTask = useCallback(
    (task: TaskItem) =>
      mutateTask(task, "/hold", { reason: "Held from Task Tree context menu" }),
    [mutateTask],
  );
  const setPinned = useCallback(
    (task: TaskItem, pinned: boolean) =>
      mutateTask(task, "/pin", { pinned, reason: pinned ? "Pinned from Task Tree" : "Unpinned from Task Tree" }),
    [mutateTask],
  );
  const cycleStatus = useCallback(
    (task: TaskItem) => setTaskStatus(task, NEXT_STATUS[task.status]),
    [setTaskStatus],
  );

  const copyTaskId = useCallback((task: TaskItem) => {
    void navigator.clipboard.writeText(task.id);
    setContextMenu(null);
  }, []);

  return (
    <div className="h-full flex flex-col bg-background">
      <header className="h-[52px] shrink-0 border-b border-border px-4 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="h-5 w-5 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold truncate">Task Tree</h2>
        </div>
        <div className="relative flex items-center gap-1">
          {headerAction.visible && (
            <Button variant="ghost" size="sm" onClick={onNewSession} title={headerAction.title}>
              <Plus className="h-4 w-4" />
              <span className="ml-1">{headerAction.label}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="Task Tree settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings className="h-4 w-4" />
          </Button>
          {settingsOpen && (
            <div className="absolute right-0 top-10 z-20 w-56 rounded-md border border-border bg-popover p-2 shadow-lg">
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={hideCompleted}
                  onChange={(event) => setHideCompleted(event.currentTarget.checked)}
                />
                완료된 태스크 숨기기
              </label>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-accent-red/30 bg-accent-red/[0.08] px-4 py-2 text-sm text-accent-red">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && tasks.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            No task items
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => {
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
                  key={task.id}
                  className={cn(
                    "group flex items-center gap-2 px-3 py-2 transition-colors",
                    row.depth === 0 ? "min-h-[62px]" : "min-h-[52px]",
                    navigationDisabled ? "text-muted-foreground" : "hover:bg-muted/45",
                    verifiedDone && "opacity-70",
                  )}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, taskId: task.id });
                  }}
                >
                  <TaskTreeLines row={row} />

                  <div className="relative flex w-8 shrink-0 self-stretch items-center justify-center">
                    <TaskStatusLineOverlay row={row} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative z-10 h-8 w-8 shrink-0"
                      disabled={pendingTaskId === task.id}
                      title={`Set ${NEXT_STATUS[task.status]}`}
                      onClick={() => void cycleStatus(task)}
                    >
                      {pendingTaskId === task.id ? (
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
                    onClick={() => navigateToTask(task)}
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
                      setContextMenu({ x: rect.right, y: rect.bottom, taskId: task.id });
                    }}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu && contextTask && (
        <TaskContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextTask}
          pending={pendingTaskId === contextTask.id}
          onClose={() => setContextMenu(null)}
          onCopy={() => copyTaskId(contextTask)}
          onStatus={(status) => void setTaskStatus(contextTask, status)}
          onPin={(pinned) => void setPinned(contextTask, pinned)}
          onHold={() => void holdTask(contextTask)}
        />
      )}
    </div>
  );
}
