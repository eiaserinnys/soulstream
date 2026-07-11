import type { PageDto } from "@seosoyoung/soul-ui/page";
import { CalendarDays, Star, X } from "lucide-react";

import { V2_TOKENS } from "./v2-token-fixture";

export interface V2LeftNavigationProps {
  selectedPageId: string | null;
  starredPages: readonly PageDto[];
  loading: boolean;
  error: string | null;
  onOpenDaily(): void;
  onOpenPage(pageId: string): void;
  onUnstarPage(page: PageDto): void;
}

export function V2LeftNavigation({
  selectedPageId,
  starredPages,
  loading,
  error,
  onOpenDaily,
  onOpenPage,
  onUnstarPage,
}: V2LeftNavigationProps) {
  return (
    <nav
      aria-label="Page navigation"
      data-v2-pane="left"
      className={`flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-3 ${V2_TOKENS.navigation}`}
      data-testid="v2-left-navigation"
    >
      <div>
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

      <div className="min-h-0">
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
    </nav>
  );
}
