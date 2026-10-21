import { useEffect, useId, useMemo, useState } from "react";
import { CalendarClock, Loader2, RefreshCw, Trash2 } from "lucide-react";

import {
  deleteClaudeSchedule,
  listClaudeSchedules,
} from "../lib/claude-runtime-actions";
import type {
  ClaudeRuntimeScheduleStatus,
  ClaudeRuntimeScheduleView,
  ClaudeRuntimeView,
} from "../stores/claude-runtime-state";
import { runtimePanelScrollClass } from "./runtime-panel-overflow";
import { Button } from "./ui/button";
import { DashboardIconCap } from "./DashboardIconCap";
import { DisclosureActionIcon } from "./DisclosureActionIcon";
import { CollapsibleCaptionHeader } from "./chat/CollapsibleCaption";

interface ClaudeRuntimeSchedulesPanelProps {
  sessionId: string;
  runtime: ClaudeRuntimeView | null;
  tone?: "default" | "calm";
  variant?: "default" | "caption";
}

const TERMINAL_STATUSES = new Set<ClaudeRuntimeScheduleStatus>([
  "completed",
  "cancelled",
  "failed",
]);

export function canDeleteClaudeRuntimeSchedule(status: ClaudeRuntimeScheduleStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

export function ClaudeRuntimeSchedulesPanel({
  sessionId,
  runtime,
  tone = "default",
  variant = "default",
}: ClaudeRuntimeSchedulesPanelProps) {
  const bodyId = useId();
  const [fetchedSchedules, setFetchedSchedules] = useState<ClaudeRuntimeScheduleView[]>([]);
  const [deletedScheduleIds, setDeletedScheduleIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const liveSchedules = useMemo(
    () => Object.values(runtime?.schedules ?? {}).sort(compareSchedules),
    [runtime],
  );
  const schedules = (liveSchedules.length > 0 ? liveSchedules : fetchedSchedules)
    .filter((schedule) => !deletedScheduleIds.has(schedule.scheduleId));
  const nextRunAt = runtime?.nextScheduleRunAt
    ?? firstNextRunAt(schedules)
    ?? null;
  const errorCount = schedules.filter(
    (schedule) => schedule.status === "failed" || schedule.status === "orphaned",
  ).length;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listClaudeSchedules(sessionId);
      setFetchedSchedules(response.schedules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFetchedSchedules([]);
    setDeletedScheduleIds(new Set());
    setExpanded(false);
    void refresh();
  }, [sessionId]);

  const removeSchedule = async (scheduleId: string) => {
    setBusyScheduleId(scheduleId);
    setError(null);
    try {
      const response = await deleteClaudeSchedule(sessionId, scheduleId);
      if (response.deleted) {
        setDeletedScheduleIds((current) => new Set([...current, scheduleId]));
        await refresh();
      } else {
        setError(`Schedule not found: ${scheduleId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyScheduleId(null);
    }
  };

  if (schedules.length === 0 && !loading && !error) return null;

  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      title="새로고침"
      disabled={loading}
      onClick={() => void refresh()}
    >
      {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
    </Button>
  );

  const captionRefreshButton = (
    <DashboardIconCap
      label="새로고침"
      size="small"
      appearance="bare"
      disabled={loading}
      onClick={() => void refresh()}
      className="shrink-0 self-end text-foreground disabled:text-muted-foreground"
      data-testid="schedule-refresh-button"
    >
      {loading
        ? <Loader2 className="size-5 animate-spin" strokeWidth={1.4} aria-hidden="true" />
        : <RefreshCw className="size-5" strokeWidth={1.4} aria-hidden="true" />}
    </DashboardIconCap>
  );

  const expandedBody = (
    <div id={bodyId} className={runtimePanelScrollClass("space-y-2")}>
      {error ? (
        <div className={`text-xs ${tone === "calm" ? "chat-tone-danger-text" : "text-destructive"}`}>
          {error}
        </div>
      ) : null}

      {schedules.map((schedule) => {
        const canDelete = canDeleteClaudeRuntimeSchedule(schedule.status);
        const busy = busyScheduleId === schedule.scheduleId;
        return (
          <div
            key={schedule.scheduleId}
            className="rounded-md border border-border bg-muted/20 p-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={statusClassName(schedule.status, tone)}>
                    {schedule.status}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {schedule.kind}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {schedule.scheduleId}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {schedule.prompt ?? schedule.cronExpression ?? "scheduled prompt"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "no next run"}
                </div>
              </div>
              <Button
                variant="destructive-outline"
                size="icon-xs"
                title="삭제"
                disabled={!canDelete || busy}
                onClick={() => void removeSchedule(schedule.scheduleId)}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (variant === "caption") {
    return (
      <section className="-mx-1 px-1 py-2 pl-4" data-slot="claude-runtime-schedules-caption">
        <div className="flex items-center justify-between gap-2">
          <CollapsibleCaptionHeader
            id={bodyId}
            expanded={expanded}
            title={
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="shrink-0 font-medium">예약 {schedules.length}</span>
                {nextRunAt ? <span className="min-w-0 truncate">다음 {formatCaptionDateTime(nextRunAt)}</span> : null}
                {errorCount > 0 ? <span className="shrink-0 chat-tone-danger-text">오류 {errorCount}</span> : null}
              </span>
            }
            align="start"
            alignmentInset="content"
            onToggle={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 motion-safe:active:scale-100"
            data-slot="manuscript-schedules-toggle"
          />
          {captionRefreshButton}
        </div>
        {expanded ? expandedBody : null}
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
          <CalendarClock className="size-4 text-muted-foreground" />
          <span>Schedules</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {schedules.length}
          </span>
          {nextRunAt ? (
            <span className="truncate text-xs font-normal text-muted-foreground">
              next {formatDateTime(nextRunAt)}
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
              tone === "calm" ? "chat-tone-danger" : "bg-destructive/10 text-destructive"
            }`}>
              {errorCount} error
            </span>
          ) : null}
        </button>
        {refreshButton}
      </div>

      {expanded ? expandedBody : null}
    </section>
  );
}

function compareSchedules(
  left: ClaudeRuntimeScheduleView,
  right: ClaudeRuntimeScheduleView,
): number {
  return (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999");
}

function firstNextRunAt(schedules: ClaudeRuntimeScheduleView[]): string | null {
  return schedules
    .filter((schedule) => schedule.status === "active" && schedule.nextRunAt)
    .map((schedule) => schedule.nextRunAt as string)
    .sort()[0] ?? null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatCaptionDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusClassName(status: ClaudeRuntimeScheduleStatus, tone: "default" | "calm"): string {
  const base = "rounded px-1.5 py-0.5 text-[11px] font-medium";
  if (status === "active") {
    if (tone === "calm") return `${base} chat-tone-success`;
    return `${base} bg-emerald-500/12 text-emerald-700 dark:text-emerald-300`;
  }
  if (status === "dispatching" || status === "firing") {
    if (tone === "calm") return `${base} chat-tone-warning`;
    return `${base} bg-amber-500/12 text-amber-700 dark:text-amber-300`;
  }
  if (status === "failed" || status === "orphaned") {
    if (tone === "calm") return `${base} chat-tone-danger`;
    return `${base} bg-destructive/12 text-destructive`;
  }
  return `${base} bg-muted text-muted-foreground`;
}
