import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight, GitBranch, ListChecks, Loader2, RefreshCw, Square, TerminalSquare } from "lucide-react";

import {
  getClaudeBackgroundTaskOutput,
  listClaudeBackgroundTasks,
  stopClaudeBackgroundTask,
  type ClaudeRuntimeTaskOutputResponse,
} from "../lib/claude-runtime-actions";
import type {
  ClaudeRuntimeModeView,
  ClaudeRuntimeTaskStatus,
  ClaudeRuntimeTaskView,
  ClaudeRuntimeView,
} from "../stores/claude-runtime-state";
import { runtimePanelScrollClass } from "./runtime-panel-overflow";
import { Button } from "./ui/button";

interface ClaudeRuntimeTasksPanelProps {
  sessionId: string;
  runtime: ClaudeRuntimeView | null;
}

const TERMINAL_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export function ClaudeRuntimeTasksPanel({
  sessionId,
  runtime,
}: ClaudeRuntimeTasksPanelProps) {
  const [fetchedTasks, setFetchedTasks] = useState<ClaudeRuntimeTaskView[]>([]);
  const [fetchedModes, setFetchedModes] = useState<{
    planMode?: ClaudeRuntimeModeView | null;
    worktreeMode?: ClaudeRuntimeModeView | null;
  } | null>(null);
  const [outputs, setOutputs] = useState<Record<string, ClaudeRuntimeTaskOutputResponse>>({});
  const [loading, setLoading] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const liveTasks = useMemo(
    () => Object.values(runtime?.tasks ?? {}).sort((a, b) => b.updatedAt - a.updatedAt),
    [runtime],
  );
  const tasks = liveTasks.length > 0 ? liveTasks : fetchedTasks;
  const planMode = runtime?.planMode ?? fetchedModes?.planMode ?? null;
  const worktreeMode = runtime?.worktreeMode ?? fetchedModes?.worktreeMode ?? null;
  const hasModeState = Boolean(planMode || worktreeMode);
  const runningCount = tasks.filter((task) => task.status === "running" || task.status === "pending").length;
  const errorCount = tasks.filter((task) => task.status === "failed" || task.status === "killed").length;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listClaudeBackgroundTasks(sessionId);
      setFetchedTasks(response.tasks);
      setFetchedModes({
        planMode: response.planMode ?? null,
        worktreeMode: response.worktreeMode ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFetchedTasks([]);
    setFetchedModes(null);
    setOutputs({});
    setExpanded(false);
    void refresh();
  }, [sessionId]);

  const openOutput = async (taskId: string) => {
    setBusyTaskId(taskId);
    setError(null);
    try {
      const response = await getClaudeBackgroundTaskOutput(sessionId, taskId);
      setOutputs((current) => ({ ...current, [taskId]: response }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  };

  const stopTask = async (taskId: string) => {
    setBusyTaskId(taskId);
    setError(null);
    try {
      await stopClaudeBackgroundTask(sessionId, taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  };

  if (tasks.length === 0 && !hasModeState && !loading && !error) return null;

  return (
    <section className="border-t border-border/70 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Bot className="size-4 text-muted-foreground" />
          <span>Claude Runtime Tasks</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {tasks.length}
          </span>
          {runningCount > 0 ? (
            <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {runningCount} active
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span className="ml-auto rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
              {errorCount} error
            </span>
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="새로고침"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {expanded ? (
        <div className={runtimePanelScrollClass("space-y-2")}>
          {error ? <div className="text-xs text-destructive">{error}</div> : null}

          {hasModeState ? (
            <div className="flex flex-wrap gap-1.5">
              {planMode ? (
                <ModeBadge
                  icon={<ListChecks className="size-3" />}
                  label={planMode.active ? "Plan mode" : "Plan off"}
                  active={planMode.active}
                />
              ) : null}
              {worktreeMode ? (
                <ModeBadge
                  icon={<GitBranch className="size-3" />}
                  label={worktreeLabel(worktreeMode)}
                  active={worktreeMode.active}
                />
              ) : null}
            </div>
          ) : null}

          {tasks.map((task) => {
            const output = outputs[task.taskId];
            const terminal = TERMINAL_STATUSES.has(task.status);
            const busy = busyTaskId === task.taskId;
            return (
              <div
                key={task.taskId}
                className="rounded-md border border-border bg-muted/20 p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={statusClassName(task.status)}>{task.status}</span>
                      <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {taskKindLabel(task)}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {task.taskId}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {task.summary ?? task.subject ?? task.description ?? task.toolUseId ?? "SDK task"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon-xs"
                      title="출력 보기"
                      disabled={busy}
                      onClick={() => void openOutput(task.taskId)}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <TerminalSquare />}
                    </Button>
                    <Button
                      variant="destructive-outline"
                      size="icon-xs"
                      title="중단"
                      disabled={terminal || busy}
                      onClick={() => void stopTask(task.taskId)}
                    >
                      <Square />
                    </Button>
                  </div>
                </div>
                {output ? (
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-xs text-foreground">
                    {output.output || output.message || "출력이 없습니다"}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ModeBadge({
  icon,
  label,
  active,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        active
          ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function worktreeLabel(mode: ClaudeRuntimeModeView): string {
  if (!mode.active) {
    return mode.worktreeAction ? `Worktree off (${mode.worktreeAction})` : "Worktree off";
  }
  return mode.worktreeName ?? mode.worktreePath ?? "Worktree mode";
}

function taskKindLabel(task: ClaudeRuntimeTaskView): string {
  if (task.taskType === "bash" && task.isBackgrounded) return "Background Bash";
  if (task.taskType === "bash") return "Bash";
  if (task.isBackgrounded) return "Background Agent";
  if (task.taskType === "agent") return "Agent";
  if (task.subject) return "SDK Task";
  return task.taskType ?? "Task";
}

function statusClassName(status: ClaudeRuntimeTaskStatus): string {
  const base = "rounded px-1.5 py-0.5 text-[11px] font-medium";
  if (status === "running" || status === "pending") {
    return `${base} bg-emerald-500/12 text-emerald-700 dark:text-emerald-300`;
  }
  if (status === "completed") {
    return `${base} bg-blue-500/12 text-blue-700 dark:text-blue-300`;
  }
  if (status === "failed" || status === "killed") {
    return `${base} bg-destructive/12 text-destructive`;
  }
  return `${base} bg-muted text-muted-foreground`;
}
