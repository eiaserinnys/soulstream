import { useTranslation } from "react-i18next";
import { useEffect, useId, useState } from "react";
import { Bell, Loader2, RefreshCw } from "lucide-react";

import { ClaudeRuntimeSignalRows } from "./ClaudeRuntimeSignalRows";
import { useClaudeRuntimeSignals } from "./claude-runtime-signals";
import { runtimePanelScrollClass } from "./runtime-panel-overflow";
import { Button } from "./ui/button";
import { DisclosureActionIcon } from "./DisclosureActionIcon";
import { CollapsibleCaptionHeader } from "./chat/CollapsibleCaption";

interface ClaudeRuntimeNotificationsPanelProps {
  sessionId: string;
  tone?: "default" | "calm";
  variant?: "default" | "caption";
}

export function ClaudeRuntimeNotificationsPanel({
  sessionId,
  tone = "default",
  variant = "default",
}: ClaudeRuntimeNotificationsPanelProps) {
  const { t } = useTranslation();
  const bodyId = useId();
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

  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      title={t("ui.common.refresh")}
      disabled={loading}
      onClick={() => void refresh()}
    >
      {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
    </Button>
  );

  const expandedBody = (
    <>
      {error ? (
        <div className={`mt-2 text-xs ${tone === "calm" ? "chat-tone-danger-text" : "text-destructive"}`}>
          {error}
        </div>
      ) : null}
      <div className={runtimePanelScrollClass()}>
        <ClaudeRuntimeSignalRows signals={signals} tone={tone} />
      </div>
    </>
  );
  const captionExpandedBody = <div id={bodyId}>{expandedBody}</div>;

  if (variant === "caption") {
    return (
      <section className="px-3 py-2" data-slot="claude-runtime-notifications-caption">
        <div className="flex items-center justify-between gap-2">
          <CollapsibleCaptionHeader
            id={bodyId}
            expanded={expanded}
            title={
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <Bell className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="shrink-0 font-medium">{t("ui.runtime.notifications")} {signals.visibleCount}</span>
                {signals.hasError ? <span className="shrink-0 chat-tone-danger-text">{t("ui.common.error")} {signals.errorCount}</span> : null}
              </span>
            }
            align="start"
            alignmentInset="content"
            onToggle={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 motion-safe:active:scale-100"
            data-slot="manuscript-notifications-toggle"
          />
          {refreshButton}
        </div>
        {expanded ? captionExpandedBody : null}
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
          <Bell className="size-4 text-muted-foreground" />
          <span className="break-keep">{t("ui.runtime.signals")}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {signals.visibleCount}
          </span>
          {signals.hasError ? (
            <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
              tone === "calm" ? "chat-tone-danger" : "bg-destructive/10 text-destructive"
            }`}>
              {t("ui.common.error")} {signals.errorCount}
            </span>
          ) : null}
        </button>
        {refreshButton}
      </div>

      {expanded ? expandedBody : null}
    </section>
  );
}
