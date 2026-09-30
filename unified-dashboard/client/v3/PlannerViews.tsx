import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardInbox } from "./CardInbox";
import { CardHandoff } from "./CardHandoff";
import { DashboardIconCap, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { Plus, Sun } from "lucide-react";

import { DailyMemo } from "./DailyMemo";
import { PlannerFolderCard } from "./PlannerFolderCard";
import type {
  DailyPlannerData,
  PlannerFolder,
} from "./planner-data";
import { visibleDailyFolders } from "./today-folder-state";
import { V3ErrorNotice } from "./V3ErrorNotice";
import type { SessionNodeConnectivity } from "./session-node-connectivity";

export type PlannerLoadState<T> =
  | { status: "loading"; data: T | null; message: null }
  | { status: "ready"; data: T; message: null }
  | { status: "error"; data: T | null; message: string };

export function DailyPlannerView({
  state,
  folders,
  selectedDate,
  isTodayView,
  todayFolderIds,
  sessions,
  nodeConnectivity,
  onSaveMemo,
  onOpenProject,
  onOpenFolder,
  onCompleteFolder,
  onToggleFolderToday,
  onMoveFolderToParent,
  onOpenRitual,
  onCreateFolder,
}: {
  state: PlannerLoadState<DailyPlannerData>;
  folders: readonly CatalogFolder[];
  selectedDate: string;
  isTodayView: boolean;
  todayFolderIds: ReadonlySet<string>;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  onSaveMemo(blockId: string | null, text: string): Promise<void>;
  onOpenProject(folderId: string): void;
  onOpenFolder(task: PlannerFolder): void;
  onCompleteFolder(task: PlannerFolder): Promise<void>;
  onToggleFolderToday(task: PlannerFolder): Promise<void>;
  onMoveFolderToParent(task: PlannerFolder): void;
  onOpenRitual(): void;
  onCreateFolder(): void;
}) {
  const byId = useCardStore(s=>s.byId);
  const cards = groupCards(Object.values(byId));
  const summary = ([ ["확인할 것",cards.attention.length], ["진행 중",cards.running.length], ["대기",cards.queued.length] ] as const).filter(([,count])=>count>0).map(([label,count])=>`${label} ${count}`).join(" / ");
  const data = state.data;
  const visibleTasks = visibleDailyFolders(data?.folders ?? [], isTodayView, todayFolderIds);
  const visibleProjects = folders.filter((folder) => visibleTasks.some((task) => task.parentFolderId === folder.id));
  const visibleProjectIds = new Set(visibleProjects.map((folder) => folder.id));
  const groups = data ? [
    ...visibleProjects.map((folder) => ({
      project: folder,
      tasks: visibleTasks.filter((task) => task.parentFolderId === folder.id),
    })),
    {
      project: null,
      tasks: visibleTasks.filter((task) => (
        task.parentFolderId === null || !visibleProjectIds.has(task.parentFolderId)
      )),
    },
  ].filter((group) => group.tasks.length > 0) : [];

  return (
    <div className="v3-planner-column v3-planner-column--daily">
      <div className="v3-today-list">
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>{formatLongDate(selectedDate)}</h1></div>
        {summary ? <p>{summary}</p> : null}
        <span className="v3-spacer" />
        <DashboardIconCap className="v3-planner-head-action" label="아침 정리" onClick={onOpenRitual}>
          <Sun className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data ? <DailyMemo blocks={data.memoBlocks} onSave={onSaveMemo} /> : null}
      <CardInbox folders={folders} />
      </div>
      <div className="v3-today-handoff"><CardHandoff folders={folders} /></div>
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <V3ErrorNotice
      className="v3-load-error"
      message="플래너를 불러오지 못했습니다."
      detail={message}
    />
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="v3-empty">{text}</div>;
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}
