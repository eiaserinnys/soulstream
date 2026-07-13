import { LockKeyhole, MessageSquare } from "lucide-react";
import type { KeyboardEvent } from "react";

import type { SessionLensState } from "./page-lenses";
import type { SessionReferenceResolution } from "./session-summary-index";

export function SessionRefBlock({
  resolution,
  lensState,
  onOpen,
  wrapText = false,
}: {
  resolution: SessionReferenceResolution;
  lensState: SessionLensState;
  onOpen(): void;
  wrapText?: boolean;
}) {
  const readableTextClass = wrapText ? "whitespace-normal break-words" : "truncate";
  const unavailableMessageClass = wrapText ? "whitespace-normal break-words" : "";
  if (resolution.kind === "unavailable") {
    return (
      <div
        role="note"
        data-session-ref-unavailable={resolution.sessionId}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg border border-dashed border-muted-foreground/35 bg-glass-surface/35 px-3 py-2 text-muted-foreground"
      >
        <LockKeyhole aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className={`${readableTextClass} text-sm font-medium`}>Unavailable session · {resolution.sessionId}</p>
          <p className={`mt-0.5 text-xs ${unavailableMessageClass}`}>{resolution.message}</p>
        </div>
      </div>
    );
  }

  const { summary } = resolution;
  const title = summary.displayName ?? summary.prompt ?? summary.agentSessionId;
  const identity = [summary.agentName ?? summary.agentId, summary.nodeId]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const accessibleLabel = wrapText
    ? [
        `Open session ${title}`,
        summary.displayName && summary.prompt ? summary.prompt : null,
        identity || null,
      ].filter((value): value is string => Boolean(value)).join(". ")
    : `Open session ${title}`;
  const activate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={accessibleLabel}
      data-session-ref={summary.agentSessionId}
      data-session-ref-wrap={wrapText ? "true" : undefined}
      data-session-status={summary.status}
      data-lens-state={lensState}
      className={`flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg border border-glass-border bg-glass-surface/55 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        lensState === "dimmed"
          ? "opacity-40"
          : lensState === "match"
            ? "border-primary/50 bg-primary/10 ring-1 ring-primary/25"
            : "hover:bg-glass-highlight/60"
      }`}
      onClick={onOpen}
      onKeyDown={activate}
    >
      <MessageSquare aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className={`flex min-w-0 gap-2 ${wrapText ? "items-start" : "items-center"}`}>
          <p className={`min-w-0 flex-1 text-sm font-semibold text-foreground ${readableTextClass}`}>{title}</p>
          <span className="shrink-0 rounded-full border border-glass-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {summary.status}
          </span>
        </div>
        {summary.displayName && summary.prompt ? (
          <p className={`mt-0.5 text-xs text-muted-foreground ${readableTextClass}`}>{summary.prompt}</p>
        ) : null}
        {identity ? <p className={`mt-1 text-[11px] text-muted-foreground ${readableTextClass}`}>{identity}</p> : null}
      </div>
    </div>
  );
}
