import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import { CalendarDays, Folder, Star, X } from "lucide-react";

import { V2_LAYOUT_SPACING, V2_TOKENS } from "./v2-token-fixture";

export interface V2LeftNavigationProps {
  selectedPageId: string | null;
  starredPages: readonly PageDto[];
  loading: boolean;
  error: string | null;
  onOpenDaily(): void;
  onOpenPage(pageId: string): void;
  onUnstarPage(page: PageDto): void;
  legacyFolders?: readonly CatalogFolder[];
  selectedLegacyFolderId?: string | null;
  legacyStatus?: { status: string; message: string | null };
  onOpenLegacyFolder?(folderId: string): void;
}

export function V2LeftNavigation({
  selectedPageId,
  starredPages,
  loading,
  error,
  onOpenDaily,
  onOpenPage,
  onUnstarPage,
  legacyFolders = [],
  selectedLegacyFolderId = null,
  legacyStatus = { status: "idle", message: null },
  onOpenLegacyFolder = () => undefined,
}: V2LeftNavigationProps) {
  const legacyRows = flattenLegacyFolders(legacyFolders);
  return (
    <nav
      aria-label="Page navigation"
      data-v2-pane="left"
      className={`flex h-full min-h-0 flex-col overflow-y-auto p-3 ${V2_TOKENS.navigation}`}
      style={{ gap: `${V2_LAYOUT_SPACING.navigationSectionGapPx}px` }}
      data-testid="v2-left-navigation"
    >
      <div data-v2-nav-section="daily" className="shrink-0">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Daily
        </p>
        <button
          type="button"
          data-testid="v2-daily-entry"
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium ${V2_TOKENS.row} ${V2_TOKENS.control}`}
          onClick={onOpenDaily}
        >
          <CalendarDays aria-hidden="true" className="h-4 w-4 text-primary" />
          <span>Today</span>
        </button>
      </div>

      <div data-v2-nav-section="starred" className="shrink-0">
        <p className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <Star aria-hidden="true" className="h-3.5 w-3.5" />
          Starred
        </p>
        {loading ? (
          <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Loading starred pages…</p>
        ) : error ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">{error}</p>
        ) : starredPages.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No starred pages yet.</p>
        ) : (
          <ul aria-label="Starred pages" className="space-y-1">
            {starredPages.map((page) => (
              <li key={page.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  aria-current={selectedPageId === page.id ? "page" : undefined}
                  className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-sm ${V2_TOKENS.row} ${V2_TOKENS.control} aria-[current=page]:bg-primary/12 aria-[current=page]:font-semibold`}
                  onClick={() => onOpenPage(page.id)}
                >
                  {page.title}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${page.title} from starred pages`}
                  className={`shrink-0 p-2 text-muted-foreground hover:text-foreground ${V2_TOKENS.control}`}
                  onClick={() => onUnstarPage(page)}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-v2-nav-section="legacy" className="shrink-0">
        <p className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <Folder aria-hidden="true" className="h-3.5 w-3.5" />
          Legacy spaces
        </p>
        {legacyStatus.status === "loading" || legacyStatus.status === "idle" ? (
          <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Loading legacy folders…</p>
        ) : legacyStatus.status !== "ready" ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {legacyStatus.message ?? "Legacy folders are unavailable."}
          </p>
        ) : legacyRows.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No legacy folders.</p>
        ) : (
          <ul aria-label="Legacy folders" className="space-y-1">
            {legacyRows.map(({ folder, depth }) => (
              <li key={folder.id}>
                <button
                  type="button"
                  data-legacy-folder-id={folder.id}
                  aria-current={selectedLegacyFolderId === folder.id ? "page" : undefined}
                  className={`w-full truncate px-3 py-2 text-left text-sm ${V2_TOKENS.row} ${V2_TOKENS.control} aria-[current=page]:bg-primary/12 aria-[current=page]:font-semibold`}
                  style={{ paddingInlineStart: `${12 + depth * 18}px` }}
                  onClick={() => onOpenLegacyFolder(folder.id)}
                >
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function flattenLegacyFolders(
  folders: readonly CatalogFolder[],
): readonly { folder: CatalogFolder; depth: number }[] {
  const rows: { folder: CatalogFolder; depth: number }[] = [];
  const visited = new Set<string>();
  const append = (parentId: string | null, depth: number) => {
    const children = folders
      .filter((folder) => (folder.parentFolderId ?? null) === parentId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
    for (const folder of children) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      rows.push({ folder, depth });
      append(folder.id, depth + 1);
    }
  };
  append(null, 0);
  return rows;
}
