import { Link2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  BrowserBacklinkDto,
  PageApiClient,
  PageLinkKind,
} from "@seosoyoung/soul-ui/page";

const KINDS: readonly PageLinkKind[] = ["mount", "inline_page", "block_ref"];
const KIND_LABEL: Record<PageLinkKind, string> = {
  mount: "Mount",
  inline_page: "Page mention",
  block_ref: "Block reference",
};

export function V2BacklinksPanel({
  pageId,
  apiClient,
  onOpenSource,
}: {
  pageId: string;
  apiClient: PageApiClient;
  onOpenSource(pageId: string, blockId: string): void;
}) {
  const [items, setItems] = useState<readonly BrowserBacklinkDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setItems([]);
    setNextCursor(null);
    setLoading(true);
    setError(null);
    void apiClient.getBacklinks(pageId, { kinds: KINDS, limit: 20 }).then(
      (result) => {
        if (requestGeneration.current !== generation) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setLoading(false);
      },
      (failure: unknown) => {
        if (requestGeneration.current !== generation) return;
        setError(failure instanceof Error ? failure.message : "Backlinks could not be loaded.");
        setLoading(false);
      },
    );
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [apiClient, pageId]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const generation = requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.getBacklinks(pageId, {
        kinds: KINDS,
        cursor: nextCursor,
        limit: 20,
      });
      if (requestGeneration.current !== generation) return;
      setItems((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (failure) {
      if (requestGeneration.current !== generation) return;
      setError(failure instanceof Error ? failure.message : "More backlinks could not be loaded.");
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  };

  return (
    <section data-testid="v2-backlinks-panel" className="shrink-0 border-t border-glass-border bg-glass-surface/30">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-5 py-2 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex items-center gap-2"><Link2 aria-hidden="true" className="h-4 w-4" />Backlinks</span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </button>
      {expanded ? (
        <div className="max-h-56 overflow-auto border-t border-glass-border px-4 py-2">
          {error ? <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          {!loading && !error && items.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">No backlinks yet.</p>
          ) : null}
          <div className="space-y-1">
            {items.map((item) => {
              const missing = !item.sourcePageId || !item.sourceBlockId || !item.sourcePageTitle;
              return missing ? (
                <div key={item.id} data-backlink-id={item.id} data-backlink-state="missing" className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
                  Referenced source unavailable or deleted.
                </div>
              ) : (
                <button
                  key={item.id}
                  type="button"
                  data-backlink-id={item.id}
                  className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-glass-highlight/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => onOpenSource(item.sourcePageId, item.sourceBlockId)}
                >
                  <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary">{KIND_LABEL[item.linkKind]}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{item.sourcePageTitle}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.sourceTextPreview || "Empty source block"}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {nextCursor ? (
            <button
              type="button"
              data-testid="backlinks-load-more"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-glass-border px-3 py-2 text-sm text-muted-foreground disabled:opacity-50"
              onClick={() => { void loadMore(); }}
            >
              {loading ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Load more
            </button>
          ) : loading ? (
            <p role="status" className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />Loading backlinks…
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
