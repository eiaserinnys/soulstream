import { useTranslation } from "react-i18next";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Bot, GitBranch, ListChecks, Loader2, RefreshCw, Square, TerminalSquare } from "lucide-react";

import {
  getClaudeBackgroundTaskOutput,
  listClaudeBackgroundTasks,
  stopClaudeBackgroundTask,
  type ClaudeRuntimeTaskOutputResponse,
} from "../lib/claude-runtime-actions";
import type {
  ClaudeRuntimeModeView,
  ClaudeRuntimeTaskView,
  ClaudeRuntimeView,
} from "../lib/claude-runtime-projection";
import type { ClaudeRuntimeTaskStatus } from "@soulstream/wire-schema";
import { runtimePanelScrollClass } from "./runtime-panel-overflow";
import { Button } from "./ui/button";
import { DisclosureActionIcon } from "./DisclosureActionIcon";
import { CollapsibleCaptionHeader } from "./chat/CollapsibleCaption";

interface ClaudeRuntimeTasksPanelProps {
  sessionId: string;
  runtime: ClaudeRuntimeView | null;
  tone?: "default" | "calm";
  variant?: "default" | "caption";
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
  tone = "default",
  variant = "default",
}: ClaudeRuntimeTasksPanelProps) {
  const { t } = useTranslation();
  const bodyId = useId();
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

  // 첫 로딩에는 헤더 단추를 돌리지 않고 본문에서 기다린다. 자료가 있는 채로
  // 새로고침할 때만 헤더 단추가 돈다.
  const firstLoading = loading && tasks.length === 0 && !hasModeState && !error;
  if (firstLoading) return null;
  const spinRefreshButton = loading && !firstLoading;
  const showBody = expanded;

  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      title={t("ui.common.refresh")}
      disabled={loading}
      onClick={() => void refresh()}
    >
      {spinRefreshButton ? <Loader2 className="animate-spin" /> : <RefreshCw />}
    </Button>
  );

  const expandedBody = (
    <div id={bodyId} className={runtimePanelScrollClass("space-y-2")}>
      {error ? (
        <div className={`text-xs ${tone === "calm" ? "chat-tone-danger-text" : "text-destructive"}`}>
          {error}
        </div>
      ) : null}

      {hasModeState ? (
        <div className="flex flex-wrap gap-1.5">
          {planMode ? (
            <ModeBadge
              icon={<ListChecks className="size-3" />}
              label={planMode.active ? t("ui.runtime.planMode") : t("ui.runtime.planModeOff")}
              active={planMode.active}
              tone={tone}
            />
          ) : null}
          {worktreeMode ? (
            <ModeBadge
              icon={<GitBranch className="size-3" />}
              label={worktreeLabel(worktreeMode, t)}
              active={worktreeMode.active}
              tone={tone}
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
            className="rounded-floor border border-border bg-muted/20 p-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={statusClassName(task.status, tone)}>{task.status}</span>
                  <span className="break-keep rounded-full bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {taskKindLabel(task, t)}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {task.taskId}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {task.summary ?? task.subject ?? task.description ?? task.toolUseId ?? t("ui.runtime.sdkTask")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-xs"
                  title={t("ui.runtime.viewOutput")}
                  disabled={busy}
                  onClick={() => void openOutput(task.taskId)}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <TerminalSquare />}
                </Button>
                <Button
                  variant="destructive-outline"
                  size="icon-xs"
                  title={t("ui.runtime.stopTask")}
                  disabled={terminal || busy}
                  onClick={() => void stopTask(task.taskId)}
                >
                  <Square />
                </Button>
              </div>
            </div>
            {output ? (
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-floor bg-background p-2 text-xs text-foreground">
                {output.output || output.message || t("ui.runtime.noOutput")}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  if (variant === "caption") {
    return (
      <section className="px-3 py-2" data-slot="claude-runtime-tasks-caption">
        <div className="flex items-center justify-between gap-2">
          <CollapsibleCaptionHeader
            id={bodyId}
            expanded={expanded}
            title={
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <Bot className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="shrink-0 font-medium">{t("ui.runtime.backgroundTasks")} {tasks.length}</span>
                {runningCount > 0 ? <span className="shrink-0">{t("ui.chat.running")} {runningCount}</span> : null}
                {errorCount > 0 ? <span className="shrink-0 chat-tone-danger-text">{t("ui.common.error")} {errorCount}</span> : null}
              </span>
            }
            align="start"
            alignmentInset="content"
            onToggle={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 motion-safe:active:scale-100"
            data-slot="manuscript-tasks-toggle"
          />
          {refreshButton}
        </div>
        {showBody ? expandedBody : null}
      </section>
    );
  }

  return (
    <section className="border-t border-border/70 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <DisclosureActionIcon expanded={expanded} className="size-3.5" />
          <Bot className="size-4 text-muted-foreground" />
          <span className="break-keep">{t("ui.runtime.backgroundTasks")}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {tasks.length}
          </span>
          {runningCount > 0 ? (
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
              tone === "calm"
                ? "chat-tone-warning"
                : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
            }`}>
              {t("ui.chat.running")} {runningCount}
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
              tone === "calm" ? "chat-tone-danger" : "bg-destructive/10 text-destructive"
            }`}>
              {t("ui.common.error")} {errorCount}
            </span>
          ) : null}
        </button>
        {refreshButton}
      </div>

      {showBody ? expandedBody : null}
    </section>
  );
}

function ModeBadge({
  icon,
  label,
  active,
  tone,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  tone: "default" | "calm";
}) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
        active
          ? tone === "calm"
            ? "chat-tone-warning"
            : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function worktreeLabel(mode: ClaudeRuntimeModeView, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!mode.active) {
    return mode.worktreeAction ? t("ui.runtime.worktreeModeOffAction", {
      action: mode.worktreeAction === "keep" ? t("ui.runtime.keep") : mode.worktreeAction === "remove" ? t("ui.runtime.remove") : mode.worktreeAction,
    }) : t("ui.runtime.worktreeModeOff");
  }
  return mode.worktreeName ?? mode.worktreePath ?? t("ui.runtime.worktreeMode");
}

function taskKindLabel(task: ClaudeRuntimeTaskView, t: ReturnType<typeof useTranslation>["t"]): string {
  if (task.taskType === "bash" && task.isBackgrounded) return t("ui.runtime.backgroundBash");
  if (task.taskType === "bash") return "Bash";
  if (task.isBackgrounded) return t("ui.runtime.backgroundAgent");
  if (task.taskType === "agent") return t("ui.chat.agent");
  if (task.subject) return t("ui.runtime.sdkTask");
  return task.taskType ?? t("ui.runtime.task");
}

function statusClassName(status: ClaudeRuntimeTaskStatus, tone: "default" | "calm"): string {
  const base = "rounded-full px-1.5 py-0.5 text-[11px] font-medium";
  if (status === "running" || status === "pending") {
    if (tone === "calm") return `${base} chat-tone-success`;
    return `${base} bg-emerald-500/12 text-emerald-700 dark:text-emerald-300`;
  }
  if (status === "completed") {
    return `${base} bg-blue-500/12 text-blue-700 dark:text-blue-300`;
  }
  if (status === "failed" || status === "killed") {
    if (tone === "calm") return `${base} chat-tone-danger`;
    return `${base} bg-destructive/12 text-destructive`;
  }
  return `${base} bg-muted text-muted-foreground`;
}
