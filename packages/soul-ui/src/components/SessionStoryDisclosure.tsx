import { useTranslation } from "react-i18next";
import { BookOpenText, ChevronDown } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/cn";
import { FrameLoading } from "./FrameLoading";
import {
  fetchSessionStory,
  type SessionStory,
} from "../shared/session-story-api";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

export const SessionHeaderPill = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(function SessionHeaderPill({ className, ...props }, ref) {
  return <button ref={ref} type="button" className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border border-glass-border bg-input/60 px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-input hover:text-foreground aria-pressed:bg-input aria-pressed:text-foreground", className)} {...props}/>;
});

export function SessionStoryDisclosure({
  className,
  sessionId,
  mode = "disclosure",
  request = globalThis.fetch,
}: {
  className?: string;
  sessionId: string;
  mode?: "disclosure" | "settings";
  request?: typeof fetch;
}) {
  const { t } = useTranslation();
  const panelId = useId();
  const requestRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [story, setStory] = useState<SessionStory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const loadStory = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setStory(null);
    setError(false);
    setLoading(true);
    try {
      const nextStory = await fetchSessionStory(
        sessionId,
        request,
        controller.signal,
      );
      if (!controller.signal.aborted) setStory(nextStory);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [request, sessionId]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setOpen(mode === "settings");
    setStory(null);
    setLoading(false);
    setError(false);
    return () => requestRef.current?.abort();
  }, [mode, sessionId]);

  useEffect(() => {
    if (mode === "settings") void loadStory();
  }, [loadStory, mode]);

  // 팝오버가 열림·닫힘을 맡는다. 열 때 스토리를 불러오고, Escape·바깥 누름으로 닫히면 요청을 끊는다.
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true);
      void loadStory();
      return;
    }
    requestRef.current?.abort();
    setOpen(false);
    setLoading(false);
  };

  if (mode === "settings") {
    return (
      <div
        className={cn("session-story-settings-content", className)}
        data-testid="session-story-settings-content"
        id={panelId}
      >
        {loading ? <LoadingState /> : null}
        {!loading && error ? (
          <div className="session-story-settings-error" role="alert">
            <p data-slot="dialog-error-message">{t("ui.session.storyLoadFailed")}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="session-story-retry"
              onClick={() => void loadStory()}
            >
              {t("ui.common.retry")}
            </Button>
          </div>
        ) : null}
        {!loading && !error && story ? (
          <StoryContent panelId={panelId} story={story} mode="settings" />
        ) : null}
      </div>
    );
  }

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          render={<SessionHeaderPill/>}
          type="button"
          aria-controls={panelId}
          aria-expanded={open}
          data-testid="session-story-trigger"
        >
          <BookOpenText className="size-3.5" aria-hidden="true" />
          <span>{t("ui.session.story")}</span>
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </PopoverTrigger>

        {/* 포털로 body에 나온 팝업은 .v3-chat-pane의 glass-chrome 범위 밖이라 .glass-strong이
            루트 값(알파 0.5)을 받아 팝오버 기본 바탕을 덮는다. 빼서 「…」 메뉴와 같은 기본 바탕을 쓴다.
            한국어는 어절 가운데서 끊지 않고(break-keep), 끊을 곳 없는 긴 경로와 해시만
            overflow-wrap:anywhere로 비상 줄바꿈한다. */}
        <PopoverPopup
          id={panelId}
          role="region"
          aria-label={t("ui.session.sessionStory")}
          data-testid="session-story-panel"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={14}
          className="max-h-[min(60vh,36rem)] w-[min(32rem,calc(100vw-1.75rem))] overflow-y-auto rounded-root border border-glass-border glass-shadow-xs p-4 text-left break-keep [overflow-wrap:anywhere] [&_[data-slot=popover-viewport]]:overflow-visible [&_[data-slot=popover-viewport]]:p-0"
        >
          {loading ? <LoadingState /> : null}
          {!loading && error ? (
            <p className="text-sm text-muted-foreground">
              {t("ui.session.storyLoadFailedHelp")}
            </p>
          ) : null}
          {!loading && !error && story ? (
            <StoryContent panelId={panelId} story={story} mode="disclosure" />
          ) : null}
        </PopoverPopup>
      </Popover>
    </span>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return <FrameLoading inline label={t("ui.session.storyLoading")} />;
}

function StoryContent({
  panelId,
  story,
  mode,
}: {
  panelId: string;
  story: SessionStory;
  mode: "disclosure" | "settings";
}) {
  const { t } = useTranslation();
  const highlightId = `${panelId}-highlight`;
  const narrativeId = `${panelId}-narrative`;
  const highlight = story.highlight?.trim() ?? "";
  const narrative = story.narrative?.trim() ?? "";
  const summaries = story.unfolded_turn_summaries;
  const empty = !highlight && !narrative && summaries.length === 0;

  if (empty) {
    return (
      <p className={mode === "settings" ? "session-story-settings-empty" : "text-sm text-muted-foreground"}>
        {t("ui.session.noStory")}
      </p>
    );
  }

  return (
    <div className={mode === "settings" ? "session-story-settings-groups" : "space-y-4"}>
      {highlight ? (
        <section aria-labelledby={highlightId} className={mode === "settings" ? "session-story-settings-section" : undefined}>
          <h3
            id={highlightId}
            className={mode === "settings" ? "session-story-settings-label" : "mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"}
          >
            {t("ui.session.highlights")}
          </h3>
          <p data-slot="session-story-body" className={mode === "settings" ? "session-story-settings-copy" : "whitespace-pre-wrap text-sm leading-relaxed text-foreground"}>
            {highlight}
          </p>
        </section>
      ) : null}

      {narrative || summaries.length > 0 ? (
        <section aria-labelledby={narrativeId} className={mode === "settings" ? "session-story-settings-section" : undefined}>
          <h3
            id={narrativeId}
            className={mode === "settings" ? "session-story-settings-label" : "mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"}
          >
            {t("ui.session.plot")}
          </h3>
          <div className={mode === "settings" ? "session-story-settings-copies" : "space-y-2 text-sm leading-relaxed text-foreground"}>
            {narrative ? <p data-slot="session-story-body" className={mode === "settings" ? "session-story-settings-copy" : "whitespace-pre-wrap"}>{narrative}</p> : null}
            {summaries.map((summary) => (
              <p
                key={summary.event_id}
                className={mode === "settings" ? "session-story-settings-copy" : "whitespace-pre-wrap"}
                data-slot="session-story-body"
                data-turn-number={summary.turn_number}
              >
                {summary.content}
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
