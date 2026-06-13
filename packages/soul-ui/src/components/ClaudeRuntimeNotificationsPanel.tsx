import { useEffect, useState } from "react";
import { Bell, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { ClaudeRuntimeSignalRows } from "./ClaudeRuntimeSignalRows";
import { useClaudeRuntimeSignals } from "./claude-runtime-signals";
import { runtimePanelScrollClass } from "./runtime-panel-overflow";
import { Button } from "./ui/button";

interface ClaudeRuntimeNotificationsPanelProps {
  sessionId: string;
  tone?: "default" | "calm";
}

export function ClaudeRuntimeNotificationsPanel({
  sessionId,
  tone = "default",
}: ClaudeRuntimeNotificationsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const { signals, loading, error, refresh } = useClaudeRuntimeSignals(sessionId);
  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  if (
    !signals.hasSignals
    && !loading
    && !error
  ) {
    return null;
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
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Bell className="size-4 text-muted-foreground" />
          <span>Runtime Signals</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {signals.visibleCount}
          </span>
          {signals.hasError ? (
            <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
              tone === "calm" ? "chat-tone-danger" : "bg-destructive/10 text-destructive"
            }`}>
              {signals.errorCount} error
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

      {expanded && error ? (
        <div className={`mt-2 text-xs ${tone === "calm" ? "chat-tone-danger-text" : "text-destructive"}`}>
          {error}
        </div>
      ) : null}
      {expanded ? (
        <div className={runtimePanelScrollClass()}>
          <ClaudeRuntimeSignalRows signals={signals} tone={tone} />
        </div>
      ) : null}
    </section>
  );
}
