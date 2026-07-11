import {
  SessionRefBlock,
  sessionLensState,
  type LegacyFolderProjection,
  type PageLens,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleAlert, FileText, Folder, LoaderCircle, LockKeyhole } from "lucide-react";
import { useRef } from "react";

import { V2PageLensControls } from "./V2PageLensControls";
import { V2_TOKENS } from "./v2-token-fixture";

const ROW_HEIGHT = 52;

export type V2LegacyFolderSurfaceState =
  | { status: "loading" | "authentication" | "forbidden" | "error" | "missing" | "empty"; message: string }
  | { status: "ready"; projection: Extract<LegacyFolderProjection, { status: "ready" }> };

export function V2LegacyFolderSurface({
  state,
  lens,
  onLensChange,
  onOpenFolder,
  onOpenSession,
}: {
  state: V2LegacyFolderSurfaceState;
  lens: PageLens;
  onLensChange(lens: PageLens): void;
  onOpenFolder(folderId: string): void;
  onOpenSession(session: SessionSummary): void;
}) {
  if (state.status !== "ready") {
    const Icon = state.status === "loading"
      ? LoaderCircle
      : state.status === "authentication" || state.status === "forbidden"
        ? LockKeyhole
        : CircleAlert;
    return (
      <main
        data-testid="v2-legacy-folder-surface"
        data-legacy-state={state.status}
        className={`flex h-full items-center justify-center p-6 ${V2_TOKENS.pageSurface}`}
      >
        <div className={`max-w-md p-6 text-center ${V2_TOKENS.state}`}>
          <Icon aria-hidden="true" className={`mx-auto mb-3 h-6 w-6 ${state.status === "loading" ? "animate-spin" : ""}`} />
          <p className="text-sm font-medium">{state.message}</p>
        </div>
      </main>
    );
  }

  return (
    <LegacyReadySurface
      projection={state.projection}
      lens={lens}
      onLensChange={onLensChange}
      onOpenFolder={onOpenFolder}
      onOpenSession={onOpenSession}
    />
  );
}

function LegacyReadySurface({
  projection,
  lens,
  onLensChange,
  onOpenFolder,
  onOpenSession,
}: {
  projection: Extract<LegacyFolderProjection, { status: "ready" }>;
  lens: PageLens;
  onLensChange(lens: PageLens): void;
  onOpenFolder(folderId: string): void;
  onOpenSession(session: SessionSummary): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: projection.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => projection.rows[index]?.id ?? index,
    initialRect: { width: 800, height: 600 },
  });

  return (
    <main
      data-testid="v2-legacy-folder-surface"
      data-legacy-state="ready"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${V2_TOKENS.pageSurface}`}
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-glass-border px-5 py-4">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Read-only virtual page
          </p>
          <h1 className="truncate text-xl font-semibold text-foreground">{projection.folder.name}</h1>
        </div>
        <V2PageLensControls lens={lens} onChange={onLensChange} />
      </header>

      {projection.rows.length === 0 ? (
        <div className="m-auto p-8 text-center text-sm text-muted-foreground">
          Nothing is stored in this legacy folder.
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          aria-label={`${projection.folder.name} legacy outline`}
          aria-readonly="true"
          className="min-h-0 flex-1 overflow-auto px-4 py-5"
        >
          <div role="none" className="relative mx-auto w-full max-w-4xl" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = projection.rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  data-legacy-row={row.id}
                  data-legacy-kind={row.kind}
                  className="absolute left-0 top-0 flex min-h-12 w-full items-start gap-2 px-2 py-1"
                  style={{
                    transform: `translateY(${item.start}px)`,
                    paddingInlineStart: `${8 + row.depth * 24}px`,
                  }}
                >
                  {row.kind === "folder" ? (
                    <button
                      type="button"
                      className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm ${V2_TOKENS.row} ${V2_TOKENS.control}`}
                      onClick={() => onOpenFolder(row.folderId)}
                    >
                      <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate">{row.title}</span>
                    </button>
                  ) : row.kind === "session" ? (
                    <SessionRefBlock
                      resolution={{ kind: "ready", sessionId: row.id, summary: row.session }}
                      lensState={sessionLensState(row.session.status, lens)}
                      onOpen={() => onOpenSession(row.session)}
                    />
                  ) : (
                    <div role="note" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/35 px-3 py-2 text-sm text-muted-foreground">
                      <FileText aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="truncate">{row.title}</span>
                      <span className="ml-auto shrink-0 text-[11px] uppercase">{row.itemType.replace("_", " ")}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
