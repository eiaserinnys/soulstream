import type {
  PageApiClient,
  PageDocumentBlock,
  PageDto,
  PageYjsClient,
  PageLens,
  SessionSummaryIndex,
} from "@seosoyoung/soul-ui/page";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { PageOutliner } from "@seosoyoung/soul-ui/page-editor";
import { CircleAlert, LoaderCircle, LockKeyhole, Star } from "lucide-react";

import { V2_TOKENS } from "./v2-token-fixture";
import { V2PageLensControls } from "./V2PageLensControls";

const EMPTY_SESSION_INDEX: SessionSummaryIndex = new Map();

export type V2PageSurfaceState =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "authentication"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
    readonly status: "ready";
    readonly page: PageDto;
    readonly blocks: readonly PageDocumentBlock[];
    readonly editor: {
      readonly doc: PageYjsClient["doc"];
      readonly apiClient: PageApiClient;
      onResync(): void;
    };
    readonly starring: boolean;
    readonly actionError?: string | null;
  };

export function V2PageSurface({
  state,
  onToggleStar,
  lens = "default",
  onLensChange = () => undefined,
  sessionIndex = EMPTY_SESSION_INDEX,
  onOpenSession,
  onCreateSessionDraft,
}: {
  state: V2PageSurfaceState;
  onToggleStar(): void;
  lens?: PageLens;
  onLensChange?(lens: PageLens): void;
  sessionIndex?: SessionSummaryIndex;
  onOpenSession?(session: SessionSummary): void;
  onCreateSessionDraft?(anchor: { pageId: string; blockId: string; expectedVersion: number }): void;
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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <V2PageLensControls lens={lens} onChange={onLensChange} />
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
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {state.actionError ? (
          <p role="alert" className="mx-4 mt-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {state.actionError}
          </p>
        ) : null}
        <PageOutliner
          pageId={state.page.id}
          doc={state.editor.doc}
          blocks={state.blocks}
          mutationVersion={state.page.version}
          apiClient={state.editor.apiClient}
          onResync={state.editor.onResync}
          sessionIndex={sessionIndex}
          lens={lens}
          onOpenSession={onOpenSession}
          onCreateSessionDraft={onCreateSessionDraft}
        />
      </div>
    </main>
  );
}
