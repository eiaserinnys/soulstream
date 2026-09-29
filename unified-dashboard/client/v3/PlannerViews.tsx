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
    <div className="v3-planner-column">
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>{formatLongDate(selectedDate)}</h1></div>
        <p>{state.status === "loading" ? "플래너를 불러오는 중…" : `${visibleTasks.length}개의 업무`}</p>
        <span className="v3-spacer" />
        <DashboardIconCap className="v3-planner-head-action" label="아침 정리" onClick={onOpenRitual}>
          <Sun className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data ? <DailyMemo blocks={data.memoBlocks} onSave={onSaveMemo} /> : null}
      <div className="v3-section-head">
        <h2>오늘의 업무</h2><span>{visibleTasks.length}개</span>
        <span className="v3-spacer" />
        <DashboardIconCap className="v3-planner-head-action" label="새 업무" onClick={onCreateFolder}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {groups.map((group) => (
        <section className="v3-project-group" key={group.project?.id ?? "unclassified"}>
          <div className="v3-project-head">
            <h3>{group.project?.name ?? "미분류"}</h3><span>{group.tasks.length}개</span>
            {group.project ? (
              <button type="button" onClick={() => onOpenProject(group.project!.id)}>아카이브 보기 ›</button>
            ) : null}
          </div>
          <div className="v3-task-list">
            {group.tasks.map((task) => (
              <PlannerFolderCard
                key={task.page.id}
                task={task}
                folder={folders.find((folder) => folder.id === task.folderId)}
                sessions={sessions}
                nodeConnectivity={nodeConnectivity}
                isInToday={todayFolderIds.has(task.page.id)}
                onOpen={() => onOpenFolder(task)}
                onComplete={() => onCompleteFolder(task)}
                onToggleToday={() => onToggleFolderToday(task)}
                onMoveToParent={() => onMoveFolderToParent(task)}
              />
            ))}
          </div>
        </section>
      ))}
      {state.status === "ready" && groups.length === 0 ? (
        <EmptyState text="이 날짜에 편입된 업무가 없습니다." />
      ) : null}
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
