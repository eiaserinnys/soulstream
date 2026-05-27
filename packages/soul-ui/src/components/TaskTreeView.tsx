import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ListChecks,
  Plus,
  Settings,
} from "lucide-react";

import type { SessionSummary, TaskItem, TaskListResponse, TaskStatus } from "../shared";
import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { VerticalSplitPane } from "./VerticalSplitPane";
import {
  TaskTreeDetailPanel,
  type TaskEditDraft,
} from "./TaskTreeDetailPanel";
import {
  buildTaskStreamUrl,
  buildTaskTreeRows,
  resolveTaskNavigationSummary,
  resolveTaskTreeHeaderAction,
  TASK_DETAIL_SPLIT_DEFAULT_TOP_PERCENT,
  TASK_DETAIL_SPLIT_MIN_BOTTOM_PX,
  TASK_DETAIL_SPLIT_MIN_TOP_PX,
} from "./task-tree-layout";
import { createTaskStreamSubscribe } from "./task-stream-subscribe";
import { TaskContextMenu } from "./TaskTreeParts";
import { TaskTreeListPanel } from "./TaskTreeListPanel";

const HIDE_COMPLETED_STORAGE_KEY = "soulstream:task-tree:hide-completed:v1";
const DETAIL_SPLIT_STORAGE_KEY = "soulstream:task-tree:detail-split-top-percent:v1";

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
  onNewSession?: (parentTask?: TaskItem) => void;
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
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
  const selectedTask =
    (selectedTaskId
      ? tasks.find((task) => task.id === selectedTaskId)
      : null) ??
    rows[0]?.task ??
    null;
  const contextTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedTaskId !== null) setSelectedTaskId(null);
      return;
    }
    if (!selectedTaskId || !rows.some((row) => row.task.id === selectedTaskId)) {
      setSelectedTaskId(rows[0].task.id);
    }
  }, [rows, selectedTaskId]);

  const actorSessionIdFor = useCallback(
    (task: TaskItem) =>
      activeSessionKey ?? task.navigationSessionId ?? task.linkedSessionId ?? task.createdFromSessionId,
    [activeSessionKey],
  );

  const navigateToTask = useCallback(
    (task: TaskItem) => {
      setSelectedTaskId(task.id);
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
  const updateTaskDetail = useCallback(
    async (task: TaskItem, draft: TaskEditDraft) => {
      const actorSessionId = actorSessionIdFor(task);
      if (!actorSessionId) return;
      setSavingTaskId(task.id);
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: actorSessionId,
            expectedVersion: task.version,
            title: draft.title,
            description: draft.description,
            acceptanceCriteria: draft.acceptanceCriteria,
            reason: "Edited from Task Tree detail panel",
          }),
        });
        if (!response.ok) {
          throw new Error(`/api/tasks/${task.id} returned ${response.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingTaskId(null);
      }
    },
    [actorSessionIdFor, refresh],
  );
  const cycleStatus = useCallback(
    (task: TaskItem) => setTaskStatus(task, NEXT_STATUS[task.status]),
    [setTaskStatus],
  );

  const copyTaskId = useCallback((task: TaskItem) => {
    void navigator.clipboard.writeText(task.id);
    setContextMenu(null);
  }, []);

  const openTaskDetail = useCallback((task: TaskItem) => {
    setSelectedTaskId(task.id);
    setContextMenu(null);
  }, []);

  const startChildSession = useCallback(
    (task: TaskItem) => {
      setSelectedTaskId(task.id);
      setContextMenu(null);
      onNewSession?.(task);
    },
    [onNewSession],
  );

  const listContent = (
    <TaskTreeListPanel
      loading={loading}
      tasks={tasks}
      rows={rows}
      selectedTaskId={selectedTask?.id ?? null}
      pendingTaskId={pendingTaskId}
      sessionById={sessionById}
      nextStatus={NEXT_STATUS}
      onSelectTask={(task) => setSelectedTaskId(task.id)}
      onNavigateTask={navigateToTask}
      onCycleStatus={cycleStatus}
      onContextMenu={(x, y, taskId) => setContextMenu({ x, y, taskId })}
    />
  );

  return (
    <div className="h-full flex flex-col bg-background">
      <header className="h-[52px] shrink-0 border-b border-border px-4 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="h-5 w-5 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold truncate">Task Tree</h2>
        </div>
        <div className="relative flex items-center gap-1">
          {headerAction.visible && (
            <Button variant="ghost" size="sm" onClick={() => onNewSession?.()} title={headerAction.title}>
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

      <div className="min-h-0 flex-1">
        <VerticalSplitPane
          top={listContent}
          bottom={
            <TaskTreeDetailPanel
              task={selectedTask}
              saving={selectedTask ? savingTaskId === selectedTask.id : false}
              onSave={(task, draft) => void updateTaskDetail(task, draft)}
            />
          }
          defaultTopPercent={TASK_DETAIL_SPLIT_DEFAULT_TOP_PERCENT}
          minTopPx={TASK_DETAIL_SPLIT_MIN_TOP_PX}
          minBottomPx={TASK_DETAIL_SPLIT_MIN_BOTTOM_PX}
          storageKey={DETAIL_SPLIT_STORAGE_KEY}
        />
      </div>

      {contextMenu && contextTask && (
        <TaskContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextTask}
          pending={pendingTaskId === contextTask.id}
          onClose={() => setContextMenu(null)}
          onCopy={() => copyTaskId(contextTask)}
          onStartChildSession={onNewSession ? () => startChildSession(contextTask) : undefined}
          onEdit={() => openTaskDetail(contextTask)}
          onStatus={(status) => void setTaskStatus(contextTask, status)}
          onPin={(pinned) => void setPinned(contextTask, pinned)}
          onHold={() => void holdTask(contextTask)}
        />
      )}
    </div>
  );
}
