import { useEffect, useMemo } from "react";

import type { CustomViewBindingData } from "./CustomViewRenderer";
import { useCustomViewStore, type CustomViewProjection } from "../stores/custom-view-store";
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

/** catalog·런북 정본에서 <soul-bind> 라이브 바인딩 데이터를 만든다 (패널·타일 공용). */
export function useCustomViewBindings(): CustomViewBindingData {
  const catalog = useDashboardStore((s) => s.catalog);
  const runbookById = useRunbookStore((s) => s.byId);

  return useMemo(() => {
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
}

/** 커스텀 뷰 문서를 로드하고 projection을 반환한다 (패널·타일 공용). */
export function useCustomViewDocument(customViewId: string | null): CustomViewProjection | undefined {
  const projection = useCustomViewStore((s) => (customViewId ? s.byId[customViewId] : undefined));
  const loadCustomView = useCustomViewStore((s) => s.loadCustomView);

  useEffect(() => {
    if (!customViewId) return;
    const controller = new AbortController();
    void loadCustomView(customViewId, { signal: controller.signal });
    return () => controller.abort();
  }, [customViewId, loadCustomView]);

  return projection;
}
