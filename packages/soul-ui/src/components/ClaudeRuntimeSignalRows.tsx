import { Bell, DatabaseZap, Radio } from "lucide-react";

import type {
  ClaudeRuntimeNotificationView,
  ClaudeRuntimeRemoteTriggerView,
} from "../stores/claude-runtime-state";
import type { ClaudeRuntimeSignalsView } from "./claude-runtime-signals";

export function ClaudeRuntimeSignalRows({ signals }: { signals: ClaudeRuntimeSignalsView }) {
  return (
    <div className="space-y-2">
      {signals.notifications.map((notification) => (
        <NotificationRow key={notification.notificationId} notification={notification} />
      ))}
      {signals.remoteTriggers.map((trigger) => (
        <RemoteTriggerRow key={trigger.triggerId} trigger={trigger} />
      ))}
      {signals.mirror ? (
        <div
          data-testid="runtime-signals-mirror-error"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <DatabaseZap className="size-3.5 shrink-0 text-destructive" />
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
              mirror
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {signals.mirror.transcriptSessionId
                ?? signals.mirror.projectKey
                ?? signals.mirror.sessionId
                ?? "transcript"}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {signals.mirror.errorCount}
            </span>
          </div>
          {signals.mirror.lastError ? (
            <div className="mt-1 line-clamp-2 text-xs text-destructive">
              {signals.mirror.lastError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({ notification }: { notification: ClaudeRuntimeNotificationView }) {
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

function RemoteTriggerRow({ trigger }: { trigger: ClaudeRuntimeRemoteTriggerView }) {
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
