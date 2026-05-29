import { useEffect, useMemo, useState } from "react";
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
import { Button } from "./ui/button";

interface ClaudeRuntimeSchedulesPanelProps {
  sessionId: string;
  runtime: ClaudeRuntimeView | null;
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
}: ClaudeRuntimeSchedulesPanelProps) {
  const [fetchedSchedules, setFetchedSchedules] = useState<ClaudeRuntimeScheduleView[]>([]);
  const [deletedScheduleIds, setDeletedScheduleIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const liveSchedules = useMemo(
    () => Object.values(runtime?.schedules ?? {}).sort(compareSchedules),
    [runtime],
  );
  const schedules = (liveSchedules.length > 0 ? liveSchedules : fetchedSchedules)
    .filter((schedule) => !deletedScheduleIds.has(schedule.scheduleId));
  const nextRunAt = runtime?.nextScheduleRunAt
    ?? firstNextRunAt(schedules)
    ?? null;

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

  return (
    <section className="border-t border-border/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <CalendarClock className="size-4 text-muted-foreground" />
          <span>Schedules</span>
          {nextRunAt ? (
            <span className="truncate text-xs font-normal text-muted-foreground">
              next {formatDateTime(nextRunAt)}
            </span>
          ) : null}
        </div>
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

      {error ? <div className="mb-2 text-xs text-destructive">{error}</div> : null}

      <div className="space-y-2">
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
                    <span className={statusClassName(schedule.status)}>
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

function statusClassName(status: ClaudeRuntimeScheduleStatus): string {
  const base = "rounded px-1.5 py-0.5 text-[11px] font-medium";
  if (status === "active") {
    return `${base} bg-emerald-500/12 text-emerald-700 dark:text-emerald-300`;
  }
  if (status === "dispatching" || status === "firing") {
    return `${base} bg-amber-500/12 text-amber-700 dark:text-amber-300`;
  }
  if (status === "failed" || status === "orphaned") {
    return `${base} bg-destructive/12 text-destructive`;
  }
  return `${base} bg-muted text-muted-foreground`;
}
