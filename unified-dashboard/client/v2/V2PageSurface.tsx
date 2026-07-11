import type { PageDto } from "@seosoyoung/soul-ui/page";
import { CircleAlert, LoaderCircle, LockKeyhole, Star } from "lucide-react";

import { V2_TOKENS } from "./v2-token-fixture";

export interface V2OutlineBlock {
  readonly id: string;
  readonly parentId: string | null;
  readonly positionKey: string;
  readonly type: string;
  readonly textValue: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly collapsed: boolean;
}

export type V2PageSurfaceState =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "authentication"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
    readonly status: "ready";
    readonly page: PageDto;
    readonly blocks: readonly V2OutlineBlock[];
    readonly starring: boolean;
    readonly actionError?: string | null;
  };

export function V2PageSurface({
  state,
  onToggleStar,
}: {
  state: V2PageSurfaceState;
  onToggleStar(): void;
}) {
  if (state.status !== "ready") {
    const Icon = state.status === "loading"
      ? LoaderCircle
      : state.status === "authentication"
        ? LockKeyhole
        : CircleAlert;
    return (
      <main
        data-testid="v2-page-surface"
        data-v2-pane="center"
        data-page-state={state.status}
        className={`flex h-full items-center justify-center p-6 ${V2_TOKENS.pageSurface}`}
      >
        <div className={`max-w-md p-6 text-center ${V2_TOKENS.state}`}>
          <Icon aria-hidden="true" className={`mx-auto mb-3 h-6 w-6 ${state.status === "loading" ? "animate-spin" : ""}`} />
          <p className="text-sm font-medium">{state.message}</p>
        </div>
      </main>
    );
  }

  const starred = state.page.metadata.starred === true;
  const depths = outlineDepths(state.blocks);
  return (
    <main
      data-testid="v2-page-surface"
      data-v2-pane="center"
      data-page-state="ready"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${V2_TOKENS.pageSurface}`}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-glass-border px-5 py-4">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {state.page.daily_date ? "Daily page" : "Page"}
          </p>
          <h1 className="truncate text-xl font-semibold text-foreground">{state.page.title}</h1>
        </div>
        <button
          type="button"
          aria-pressed={starred}
          aria-label={starred ? "Remove page from starred pages" : "Add page to starred pages"}
          disabled={state.starring}
          className={`flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 ${V2_TOKENS.control}`}
          onClick={onToggleStar}
        >
          <Star aria-hidden="true" className={`h-4 w-4 ${starred ? "fill-current text-primary" : ""}`} />
          <span>{starred ? "Starred" : "Star"}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {state.actionError ? (
          <p role="alert" className="mx-auto mb-3 max-w-4xl rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {state.actionError}
          </p>
        ) : null}
        {state.blocks.length === 0 ? (
          <div
            data-testid="v2-empty-page"
            className={`mx-auto mt-10 max-w-lg p-8 text-center ${V2_TOKENS.state}`}
          >
            <p className="font-medium text-foreground">This page is empty.</p>
            <p className="mt-2 text-sm">Ready for the editor in the next phase.</p>
          </div>
        ) : (
          <ol aria-label="Read-only page outline" aria-readonly="true" className="mx-auto max-w-4xl space-y-1">
            {state.blocks.map((block) => (
              <li
                key={block.id}
                data-block-id={block.id}
                data-outline-depth={depths.get(block.id) ?? 0}
                className={`min-h-9 px-3 py-2 text-sm ${V2_TOKENS.row}`}
                style={{ paddingInlineStart: `${12 + (depths.get(block.id) ?? 0) * 24}px` }}
              >
                <span className="mr-2 text-muted-foreground" aria-hidden="true">•</span>
                <span>{block.textValue || "Empty block"}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}

function outlineDepths(blocks: readonly V2OutlineBlock[]): ReadonlyMap<string, number> {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const depths = new Map<string, number>();
  for (const block of blocks) {
    let depth = 0;
    let parentId = block.parentId;
    const visited = new Set<string>([block.id]);
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    depths.set(block.id, depth);
  }
  return depths;
}
