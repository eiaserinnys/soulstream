import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleSlash,
  ListChecks,
  Loader2,
  OctagonAlert,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import type { SessionSummary, TaskItem, TaskListResponse, TaskStatus } from "../shared";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

const STATUS_META: Record<
  TaskStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  open: { label: "Open", icon: Circle, className: "text-muted-foreground" },
  in_progress: { label: "In Progress", icon: Play, className: "text-info" },
  agent_done: { label: "Agent Done", icon: CheckCircle2, className: "text-primary" },
  verified_done: { label: "Verified", icon: ShieldCheck, className: "text-success" },
  reopened: { label: "Reopened", icon: RotateCcw, className: "text-accent-amber" },
  blocked: { label: "Blocked", icon: OctagonAlert, className: "text-accent-red" },
  cancelled: { label: "Cancelled", icon: CircleSlash, className: "text-muted-foreground" },
};

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
}

interface TaskNode {
  task: TaskItem;
  depth: number;
}

export function TaskTreeView({ sessions = [] }: TaskTreeViewProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const session of sessions) {
      map.set(session.agentSessionId, session);
    }
    return map;
  }, [sessions]);

  const refresh = useCallback(async () => {
    setLoading(true);
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
    void refresh();
  }, [refresh]);

  const flattened = useMemo(() => flattenTasks(tasks), [tasks]);

  const navigateToTask = useCallback(
    (task: TaskItem) => {
      const sessionId = task.navigationSessionId ?? task.linkedSessionId;
      if (!sessionId) return;
      setActiveSession(sessionId);
      setFocusEventId(task.navigationEventId ?? null);
      setActiveTab("chat");
    },
    [setActiveSession, setActiveTab, setFocusEventId],
  );

  const cycleStatus = useCallback(
    async (task: TaskItem) => {
      const actorSessionId =
        activeSessionKey ?? task.navigationSessionId ?? task.createdFromSessionId;
      if (!actorSessionId) return;
      setPendingTaskId(task.id);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: actorSessionId,
            status: NEXT_STATUS[task.status],
            expectedVersion: task.version,
          }),
        });
        if (!response.ok) {
          throw new Error(`/api/tasks/${task.id}/status returned ${response.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingTaskId(null);
      }
    },
    [activeSessionKey, refresh],
  );

  return (
    <div className="h-full flex flex-col bg-background">
      <header className="h-[52px] shrink-0 border-b border-border px-4 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="h-5 w-5 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold truncate">Task Tree</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
        </Button>
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
        ) : flattened.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            No task items
          </div>
        ) : (
          <div className="divide-y divide-border">
            {flattened.map(({ task, depth }) => {
              const StatusIcon = STATUS_META[task.status].icon;
              const navigationDisabled = !(task.navigationSessionId ?? task.linkedSessionId);
              const linkedSession = task.linkedSessionId
                ? sessionById.get(task.linkedSessionId)
                : undefined;
              const portraitUrl = linkedSession?.agentPortraitUrl ?? null;
              return (
                <div
                  key={task.id}
                  className={cn(
                    "group min-h-[58px] flex items-center gap-2 px-3 py-2 transition-colors",
                    navigationDisabled ? "text-muted-foreground" : "hover:bg-muted/45",
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
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

                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    style={{ paddingLeft: depth * 18 }}
                    disabled={navigationDisabled}
                    onClick={() => navigateToTask(task)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm truncate">{task.title}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {STATUS_META[task.status].label}
                      </span>
                    </div>
                    {(task.acceptanceCriteria || task.description) && (
                      <div className="text-xs text-muted-foreground truncate">
                        {task.acceptanceCriteria || task.description}
                      </div>
                    )}
                  </button>

                  <AgentAvatar portraitUrl={portraitUrl} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentAvatar({ portraitUrl }: { portraitUrl: string | null }) {
  if (portraitUrl) {
    return (
      <img
        src={portraitUrl}
        alt=""
        className="h-8 w-8 rounded-lg object-cover shrink-0"
      />
    );
  }
  return (
    <span className="h-8 w-8 rounded-lg border border-border bg-muted flex items-center justify-center text-xs text-muted-foreground shrink-0">
      A
    </span>
  );
}

function flattenTasks(tasks: TaskItem[]): TaskNode[] {
  const children = new Map<string | null, TaskItem[]>();
  for (const task of tasks) {
    const key = task.parentId ?? null;
    const bucket = children.get(key) ?? [];
    bucket.push(task);
    children.set(key, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.positionKey - b.positionKey || a.createdAt.localeCompare(b.createdAt));
  }

  const result: TaskNode[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskItem, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    result.push({ task, depth });
    for (const child of children.get(task.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of children.get(null) ?? []) {
    visit(root, 0);
  }
  for (const task of tasks) {
    if (!seen.has(task.id)) {
      visit(task, 0);
    }
  }
  return result;
}
