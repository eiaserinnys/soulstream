import { AlertTriangle, LoaderCircle, RefreshCw, X } from "lucide-react";

import type { PageEditorMutationState } from "./usePageEditorController";

export function PageEditorMutationStatus({ state, onDismiss, onResync }: {
  state: PageEditorMutationState;
  onDismiss(): void;
  onResync(): void;
}) {
  if (state.status === "idle") return null;
  const pending = state.status === "pending" || state.status === "resyncing";
  return (
    <div
      role={pending ? "status" : "alert"}
      aria-live="polite"
      data-editor-state={state.status}
      className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/80 px-3 py-2 text-sm text-foreground"
    >
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />}
      <span className="flex-1">{state.message}</span>
      {state.status === "conflict" ? (
        <button type="button" data-testid="page-editor-resync" className="inline-flex items-center gap-1 rounded px-2 py-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onResync}>
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Reload
        </button>
      ) : state.status === "error" ? (
        <button type="button" aria-label="Dismiss editor error" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onDismiss}>
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function PageEditorFeedback({ message, onDismiss }: { message: string | null; onDismiss(): void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      data-editor-feedback="error"
      className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/80 px-3 py-2 text-sm text-foreground"
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
      <span className="flex-1">{message}</span>
      <button type="button" aria-label="Dismiss editor feedback" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onDismiss}>
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
