import { useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";

import { CustomViewIframe, type CustomViewBindingData } from "../custom-view/CustomViewRenderer";
import { useCustomViewStore } from "../stores/custom-view-store";
import { useDashboardStore } from "../stores/dashboard-store";
import { useRunbookStore, type RunbookSnapshot } from "../stores/runbook-store";

function sessionTitle(session: { displayName?: string | null; prompt?: string; agentSessionId: string }): string {
  return session.displayName || session.prompt || session.agentSessionId;
}

function runbookProgress(snapshot: RunbookSnapshot): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const item of snapshot.items) {
    if (item.archived || item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }
  return { completed, total };
}

function buildBindings(
  runbookSnapshots: readonly RunbookSnapshot[],
  sessions: CustomViewBindingData["sessions"],
): CustomViewBindingData {
  const runbooks: CustomViewBindingData["runbooks"] = {};
  const runbookItems: CustomViewBindingData["runbookItems"] = {};

  for (const snapshot of runbookSnapshots) {
    runbooks[snapshot.runbook.id] = runbookProgress(snapshot);
    for (const item of snapshot.items) {
      runbookItems[item.id] = {
        title: item.title,
        status: item.status,
      };
    }
  }

  return { runbookItems, runbooks, sessions };
}

export function CustomViewPanel() {
  const activeCustomViewId = useDashboardStore((s) => s.activeCustomViewId);
  const catalog = useDashboardStore((s) => s.catalog);
  const customViewProjection = useCustomViewStore((s) =>
    activeCustomViewId ? s.byId[activeCustomViewId] : undefined
  );
  const loadCustomView = useCustomViewStore((s) => s.loadCustomView);
  const runbookById = useRunbookStore((s) => s.byId);

  useEffect(() => {
    if (!activeCustomViewId) return;
    const controller = new AbortController();
    void loadCustomView(activeCustomViewId, { signal: controller.signal });
    return () => controller.abort();
  }, [activeCustomViewId, loadCustomView]);

  const bindings = useMemo(() => {
    const sessions: CustomViewBindingData["sessions"] = {};
    for (const session of catalog?.sessionList ?? []) {
      sessions[session.agentSessionId] = {
        title: sessionTitle(session),
        status: session.status,
      };
    }
    for (const [sessionId, assignment] of Object.entries(catalog?.sessions ?? {})) {
      if (sessions[sessionId]) continue;
      sessions[sessionId] = {
        title: assignment.displayName || sessionId,
        status: "unknown",
      };
    }

    const runbookSnapshots = Object.values(runbookById)
      .map((projection) => projection.snapshot)
      .filter((snapshot): snapshot is RunbookSnapshot => Boolean(snapshot));
    return buildBindings(runbookSnapshots, sessions);
  }, [catalog?.sessionList, catalog?.sessions, runbookById]);

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
