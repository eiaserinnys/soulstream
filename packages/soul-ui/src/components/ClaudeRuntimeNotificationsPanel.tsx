import { useEffect, useMemo, useState } from "react";
import { Bell, DatabaseZap, Loader2, Radio, RefreshCw } from "lucide-react";

import { listClaudeBackgroundTasks } from "../lib/claude-runtime-actions";
import type {
  ClaudeRuntimeNotificationView,
  ClaudeRuntimeRemoteTriggerView,
  ClaudeRuntimeTranscriptMirrorView,
  ClaudeRuntimeView,
} from "../stores/claude-runtime-state";
import { Button } from "./ui/button";

interface ClaudeRuntimeNotificationsPanelProps {
  sessionId: string;
  runtime: ClaudeRuntimeView | null;
}

export function ClaudeRuntimeNotificationsPanel({
  sessionId,
  runtime,
}: ClaudeRuntimeNotificationsPanelProps) {
  const [fetchedNotifications, setFetchedNotifications] = useState<
    ClaudeRuntimeNotificationView[]
  >([]);
  const [fetchedRemoteTriggers, setFetchedRemoteTriggers] = useState<
    ClaudeRuntimeRemoteTriggerView[]
  >([]);
  const [fetchedMirror, setFetchedMirror] = useState<
    ClaudeRuntimeTranscriptMirrorView | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listClaudeBackgroundTasks(sessionId);
      setFetchedNotifications(response.notifications ?? []);
      setFetchedRemoteTriggers(response.remoteTriggers ?? []);
      setFetchedMirror(response.transcriptMirror ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFetchedNotifications([]);
    setFetchedRemoteTriggers([]);
    setFetchedMirror(null);
    void refresh();
  }, [sessionId]);

  const notifications = useMemo(
    () => {
      const live = Object.values(runtime?.notifications ?? {});
      return [...(live.length > 0 ? live : fetchedNotifications)]
        .sort(compareUpdatedAt)
        .slice(0, 5);
    },
    [fetchedNotifications, runtime],
  );
  const remoteTriggers = useMemo(
    () => {
      const live = Object.values(runtime?.remoteTriggers ?? {});
      return [...(live.length > 0 ? live : fetchedRemoteTriggers)]
        .sort(compareUpdatedAt)
        .slice(0, 5);
    },
    [fetchedRemoteTriggers, runtime],
  );
  const mirror = runtime?.transcriptMirror ?? fetchedMirror;

  if (
    notifications.length === 0
    && remoteTriggers.length === 0
    && !mirror
    && !loading
    && !error
  ) {
    return null;
  }

  return (
    <section className="border-t border-border/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bell className="size-4 text-muted-foreground" />
          <span>Runtime Signals</span>
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
        {notifications.map((notification) => (
          <NotificationRow
            key={notification.notificationId}
            notification={notification}
          />
        ))}
        {remoteTriggers.map((trigger) => (
          <RemoteTriggerRow key={trigger.triggerId} trigger={trigger} />
        ))}
        {mirror ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <DatabaseZap className="size-3.5 shrink-0 text-destructive" />
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                mirror
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {mirror.transcriptSessionId ?? mirror.projectKey ?? mirror.sessionId ?? "transcript"}
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {mirror.errorCount}
              </span>
            </div>
            {mirror.lastError ? (
              <div className="mt-1 line-clamp-2 text-xs text-destructive">
                {mirror.lastError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function NotificationRow({
  notification,
}: {
  notification: ClaudeRuntimeNotificationView;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <Bell className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {notification.notificationType ?? notification.key ?? notification.source}
        </span>
        <span className="truncate text-xs font-medium">
          {notification.title ?? notification.message}
        </span>
      </div>
      {notification.title && notification.message !== notification.title ? (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {notification.message}
        </div>
      ) : null}
    </div>
  );
}

function RemoteTriggerRow({
  trigger,
}: {
  trigger: ClaudeRuntimeRemoteTriggerView;
}) {
  const label = trigger.originName
    ?? trigger.originFrom
    ?? trigger.triggerType
    ?? trigger.source;

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <Radio className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          remote
        </span>
        <span className="truncate text-xs font-medium">{label}</span>
      </div>
      {trigger.prompt ? (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {trigger.prompt}
        </div>
      ) : null}
    </div>
  );
}

function compareUpdatedAt<T extends { updatedAt: number }>(left: T, right: T): number {
  return right.updatedAt - left.updatedAt;
}
