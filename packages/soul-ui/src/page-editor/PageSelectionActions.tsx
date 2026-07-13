import { useEffect, useState } from "react";

import type { BrowserPageSearchItemDto, PageApiClient } from "../page";

export function PageSelectionActions({
  apiClient,
  currentPageId,
  defaultTitle,
  disabled,
  onExtractNew,
  onExtractExisting,
}: {
  apiClient: PageApiClient;
  currentPageId: string;
  defaultTitle: string;
  disabled: boolean;
  onExtractNew(title: string): void;
  onExtractExisting(pageId: string): void;
}) {
  const [mode, setMode] = useState<"closed" | "new" | "existing">("closed");
  const [title, setTitle] = useState(defaultTitle);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly BrowserPageSearchItemDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => setTitle(defaultTitle), [defaultTitle]);

  const search = async () => {
    const normalized = query.trim();
    if (!normalized) return;
    setSearching(true);
    setSearchError(null);
    try {
      const response = await apiClient.searchPages(normalized, 20);
      setResults(response.items.filter((page) => page.pageId !== currentPageId));
    } catch {
      setResults([]);
      setSearchError("페이지를 찾지 못했습니다. 다시 시도해주세요.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div
      data-testid="page-selection-actions"
      className="mx-auto mb-2 flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/90 p-2 text-sm"
    >
      <span className="font-medium text-foreground">Selected blocks</span>
      <button type="button" disabled={disabled} className="rounded-md border px-2 py-1" onClick={() => setMode("new")}>
        새 페이지로 추출
      </button>
      <button type="button" disabled={disabled} className="rounded-md border px-2 py-1" onClick={() => setMode("existing")}>
        기존 페이지로 보내기
      </button>
      {mode === "new" ? (
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = title.trim();
            if (normalized) onExtractNew(normalized);
          }}
        >
          <input
            aria-label="New page title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1"
          />
          <button type="submit" disabled={disabled || !title.trim()} className="rounded-md border px-2 py-1">추출</button>
        </form>
      ) : null}
      {mode === "existing" ? (
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <form
            className="flex gap-2"
            onSubmit={(event) => { event.preventDefault(); void search(); }}
          >
            <input
              aria-label="Find target page"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1"
            />
            <button type="submit" disabled={searching || !query.trim()} className="rounded-md border px-2 py-1">
              {searching ? "검색 중…" : "검색"}
            </button>
          </form>
          {results.map((page) => (
            <button
              key={page.pageId}
              type="button"
              className="rounded-md px-2 py-1 text-left hover:bg-muted"
              onClick={() => onExtractExisting(page.pageId)}
            >
              {page.title}
            </button>
          ))}
          {searchError ? <p role="alert" className="text-xs text-destructive">{searchError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
