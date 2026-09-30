import { useCardStore } from "../cards/card-store";
import { useEffect, useMemo } from "react";

import type { CustomViewBindingData } from "./CustomViewRenderer";
import { useCustomViewStore, type CustomViewProjection } from "../stores/custom-view-store";
import { useDashboardStore } from "../stores/dashboard-store";
import { useFolderCardStore, type FolderSnapshot } from "../stores/folder-card-store";

function sessionTitle(session: { displayName?: string | null; prompt?: string; agentSessionId: string }): string {
  return session.displayName || session.prompt || session.agentSessionId;
}

function taskProgress(snapshot: FolderSnapshot): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const item of snapshot.cards) {
    if (item.archived || item.status === "cancelled") continue;
    total += 1;
    if (item.status === "done") completed += 1;
  }
  return { completed, total };
}

function buildBindings(
  taskSnapshots: readonly FolderSnapshot[],
  sessions: CustomViewBindingData["sessions"],
): CustomViewBindingData {
  const tasks: CustomViewBindingData["tasks"] = {};
  const taskItems: CustomViewBindingData["taskItems"] = {};

  for (const snapshot of taskSnapshots) {
    tasks[snapshot.folder.id] = taskProgress(snapshot);
    for (const item of snapshot.cards) {
      taskItems[item.id] = {
        title: item.title,
        status: item.status,
      };
    }
  }

  return { taskItems, tasks, sessions };
}

/** catalog·폴더 정본에서 <soul-bind> 라이브 바인딩 데이터를 만든다 (패널·타일 공용). */
export function useCustomViewBindings(): CustomViewBindingData {
  const catalog = useDashboardStore((s) => s.catalog);
  const cards = useCardStore(s=>s.byId);
  const taskById = useFolderCardStore((s) => s.byId);

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

    const taskSnapshots = Object.values(taskById)
      .map((projection) => projection.snapshot)
      .filter((snapshot): snapshot is FolderSnapshot => Boolean(snapshot));
    return buildBindings(taskSnapshots.map(snapshot=>({...snapshot,cards:Object.values(cards).filter(card=>card.folderId===snapshot.folder.id)})), sessions);
  }, [catalog?.sessionList, catalog?.sessions, taskById, cards]);
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
