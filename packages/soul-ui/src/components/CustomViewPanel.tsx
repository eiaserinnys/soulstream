import { Loader2 } from "lucide-react";

import { CustomViewIframe } from "../custom-view/CustomViewRenderer";
import {
  useCustomViewBindings,
  useCustomViewDocument,
} from "../custom-view/use-custom-view-bindings";
import { useDashboardStore } from "../stores/dashboard-store";

export function CustomViewPanel() {
  const activeCustomViewId = useDashboardStore((s) => s.activeCustomViewId);
  const customViewProjection = useCustomViewDocument(activeCustomViewId ?? null);
  const bindings = useCustomViewBindings();

  if (!activeCustomViewId) return null;

  const document = customViewProjection?.document ?? null;
  const status = customViewProjection?.status ?? "idle";
  const isLoading = status === "loading" || (status === "idle" && !document);
  const title = document?.title?.trim() || "Custom view";

  return (
    <div data-testid="custom-view-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--lg-line)] px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        {document && (
          <span className="shrink-0 rounded-full border border-[var(--lg-line)] px-2 py-0.5 text-[11px] text-muted-foreground">
            r{document.revision}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {isLoading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading
          </div>
        )}
        {status === "error" && (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
            {customViewProjection?.error ?? "Custom view load failed"}
          </div>
        )}
        {document && status !== "error" && (
          <CustomViewIframe
            html={document.html}
            bindings={bindings}
            title={title}
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
