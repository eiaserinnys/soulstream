import { BookOpenText, ChevronDown, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "../lib/cn";
import {
  fetchSessionStory,
  type SessionStory,
} from "../shared/session-story-api";

export function SessionStoryDisclosure({
  className,
  sessionId,
}: {
  className?: string;
  sessionId: string;
}) {
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
        globalThis.fetch,
        controller.signal,
      );
      if (!controller.signal.aborted) setStory(nextStory);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setOpen(false);
    setStory(null);
    setLoading(false);
    setError(false);
    return () => requestRef.current?.abort();
  }, [sessionId]);

  const toggle = () => {
    if (open) {
      requestRef.current?.abort();
      setOpen(false);
      setLoading(false);
      return;
    }
    setOpen(true);
    void loadStory();
  };

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-glass-border bg-input/60 px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-input hover:text-foreground"
        aria-controls={panelId}
        aria-expanded={open}
        data-testid="session-story-trigger"
        onClick={toggle}
      >
        <BookOpenText className="size-3.5" aria-hidden="true" />
        <span>스토리</span>
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="세션 스토리"
          data-testid="session-story-panel"
          className="absolute right-0 top-full z-50 mt-2 max-h-[min(60vh,36rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-3xl border border-glass-border glass-strong glass-shadow-xs p-4 text-left"
        >
          {loading ? <LoadingState /> : null}
          {!loading && error ? (
            <p className="text-sm text-muted-foreground">
              스토리를 불러오지 못했습니다. 패널을 다시 열어 주세요.
            </p>
          ) : null}
          {!loading && !error && story ? (
            <StoryContent panelId={panelId} story={story} />
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      스토리를 불러오는 중입니다.
    </div>
  );
}

function StoryContent({
  panelId,
  story,
}: {
  panelId: string;
  story: SessionStory;
}) {
  const highlightId = `${panelId}-highlight`;
  const narrativeId = `${panelId}-narrative`;
  const highlight = story.highlight?.trim() ?? "";
  const narrative = story.narrative?.trim() ?? "";
  const summaries = story.unfolded_turn_summaries;
  const empty = !highlight && !narrative && summaries.length === 0;

  if (empty) {
    return (
      <p className="text-sm text-muted-foreground">
        아직 정리된 스토리가 없습니다.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {highlight ? (
        <section aria-labelledby={highlightId}>
          <h3
            id={highlightId}
            className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            하이라이트
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {highlight}
          </p>
        </section>
      ) : null}

      {narrative || summaries.length > 0 ? (
        <section aria-labelledby={narrativeId}>
          <h3
            id={narrativeId}
            className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            줄거리
          </h3>
          <div className="space-y-2 text-sm leading-relaxed text-foreground">
            {narrative ? <p className="whitespace-pre-wrap">{narrative}</p> : null}
            {summaries.map((summary) => (
              <p
                key={summary.event_id}
                className="whitespace-pre-wrap"
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
