import { useEffect, useMemo, useState } from "react";
import {
  BookOpenCheck,
  ListChecks,
  RefreshCw,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { DASHBOARD_LIST_INSET_PX } from "../components/dashboard-spacing";
import { LiquidGlassCard } from "../components/LiquidGlassCard";
import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  type TaskOverviewGroup,
  type TaskOverviewItem,
  useTaskStore,
} from "../stores/task-store";
import { isTaskCompleted } from "./TaskCompletionAction";
import { TaskOverviewRunningSessions } from "./TaskOverviewRunningSessions";
import {
  TaskItemsPane,
  TaskListRow,
  countAttentionItems,
  taskAttentionCounts,
} from "./TaskOverviewRows";

function TaskListPane({
  activeGroups,
  completedGroups,
  myTurnItems,
  selectedTaskId,
  completedGroupsOpen,
  onSelectTask,
  onToggleCompletedGroups,
  onOpenTaskBoard,
  onStatusChanged,
}: {
  activeGroups: TaskOverviewGroup[];
  completedGroups: TaskOverviewGroup[];
  myTurnItems: TaskOverviewItem[];
  selectedTaskId: string | null;
  completedGroupsOpen: boolean;
  onSelectTask: (taskId: string) => void;
  onToggleCompletedGroups: () => void;
  onOpenTaskBoard: (group: TaskOverviewGroup) => void;
  onStatusChanged: () => Promise<void>;
}) {
  return (
    <section
      data-testid="task-overview-task-list-pane"
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">업무별 진행</h2>
        <Badge variant="outline" size="sm" className="h-5 px-1.5 text-[10px]">
          {activeGroups.length}
        </Badge>
      </div>
      <div
        data-testid="task-overview-task-list-scroll"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
      >
        {activeGroups.length > 0 ? (
          activeGroups.map((group) => (
            <TaskListRow
              key={group.task_id}
              group={group}
              attention={taskAttentionCounts(group, myTurnItems)}
              selected={selectedTaskId === group.task_id}
              onSelect={() => onSelectTask(group.task_id)}
              onOpenTaskBoard={onOpenTaskBoard}
              onStatusChanged={onStatusChanged}
            />
          ))
        ) : (
          <div className="rounded-[14px] border border-dashed border-[var(--lg-line)] px-3 py-5 text-center text-sm text-muted-foreground">
            진행 중인 업무 없음
          </div>
        )}

        {completedGroups.length > 0 ? (
          <div
            data-testid="task-overview-completed-groups"
            className="rounded-[14px] border border-glass-border glass glass-shadow-xs"
          >
            <button
              type="button"
              aria-expanded={completedGroupsOpen}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left"
              onClick={onToggleCompletedGroups}
            >
              <DisclosureActionIcon
                expanded={completedGroupsOpen}
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">완료됨</span>
              <Badge variant="success" size="sm" className="h-5 px-1.5 text-[10px]">
                {completedGroups.length}
              </Badge>
            </button>
            {completedGroupsOpen ? (
              <div className="space-y-2 border-t border-[var(--lg-line)] p-2">
                {completedGroups.map((group) => (
                  <TaskListRow
                    key={group.task_id}
                    group={group}
                    attention={taskAttentionCounts(group, myTurnItems)}
                    selected={selectedTaskId === group.task_id}
                    onSelect={() => onSelectTask(group.task_id)}
                    onOpenTaskBoard={onOpenTaskBoard}
                    onStatusChanged={onStatusChanged}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function TaskOverview() {
  const projection = useTaskStore((s) => s.overview);
  const loadOverview = useTaskStore((s) => s.loadOverview);
  const openTaskBoard = useDashboardStore((s) => s.openTaskBoard);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [completedGroupsOpen, setCompletedGroupsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadOverview({ signal: controller.signal });
    return () => controller.abort();
  }, [loadOverview]);

  const snapshot = projection.snapshot;
  const myTurnItems = snapshot?.my_turn_items ?? [];
  const myTurnDisplayCount = useMemo(
    () => countAttentionItems(myTurnItems).total,
    [myTurnItems],
  );
  const groups = useMemo(
    () => (snapshot?.tasks ?? []).filter((group) => group.total_count > 0),
    [snapshot?.tasks],
  );
  const activeGroups = useMemo(
    () => groups.filter((group) => !isTaskCompleted(group.task_status)),
    [groups],
  );
  const completedGroups = useMemo(
    () => groups.filter((group) => isTaskCompleted(group.task_status)),
    [groups],
  );
  const selectableGroups = useMemo(
    () => [...activeGroups, ...completedGroups],
    [activeGroups, completedGroups],
  );
  const effectiveSelectedTaskId = useMemo(() => {
    if (
      selectedTaskId &&
      selectableGroups.some((group) => group.task_id === selectedTaskId)
    ) {
      return selectedTaskId;
    }
    return selectableGroups[0]?.task_id ?? null;
  }, [selectableGroups, selectedTaskId]);
  const selectedGroup = useMemo(
    () => selectableGroups.find((group) => group.task_id === effectiveSelectedTaskId) ?? null,
    [effectiveSelectedTaskId, selectableGroups],
  );
  const loading = projection.status === "loading";
  const refreshing = projection.isRefreshing;
  const error = projection.error;

  useEffect(() => {
    setSelectedTaskId((current) => {
      if (selectableGroups.length === 0) return null;
      if (current && selectableGroups.some((group) => group.task_id === current)) {
        return current;
      }
      return selectableGroups[0].task_id;
    });
  }, [selectableGroups]);

  const openBoardItem = (item: TaskOverviewItem) => {
    openTaskBoard(item.task_id, item.folder_id);
  };

  const openGroupBoard = (group: TaskOverviewGroup) => {
    openTaskBoard(group.task_id, group.folder_id);
  };

  const refreshOverview = async () => {
    await loadOverview({ force: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <header
        className="shrink-0 border-b border-glass-border glass-strong glass-chrome glass-shadow-xs py-4"
        style={{ paddingInline: DASHBOARD_LIST_INSET_PX }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent-blue/30 glass text-accent-blue">
            <BookOpenCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-6">업무</h1>
            <p className="truncate text-xs text-muted-foreground">
              확인 {myTurnDisplayCount}개 · 진행 {activeGroups.length}개 · 완료 {completedGroups.length}개
            </p>
          </div>
          {refreshing ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              동기화
            </span>
          ) : null}
        </div>
      </header>

      <main
        className="min-h-0 flex-1 overflow-hidden"
        style={{
          paddingInline: DASHBOARD_LIST_INSET_PX,
          paddingBlock: DASHBOARD_LIST_INSET_PX,
          scrollbarGutter: "stable",
        }}
      >
        {loading && !snapshot ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            불러오는 중
          </div>
        ) : null}

        {error && !snapshot ? (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
            {error}
          </div>
        ) : null}

        {snapshot ? (
          <div className="flex h-full min-h-0 w-full flex-col gap-3">
            <LiquidGlassCard
              webglSurface
              data-testid="task-overview-dashboard"
              className="shrink-0 rounded-[16px] border border-accent-blue/30 p-3 shadow-[0_10px_26px_-20px_rgb(30_84_160_/_50%)]"
            >
              <TaskOverviewRunningSessions />
            </LiquidGlassCard>

            <div
              data-testid="task-overview-split-layout"
              className="flex min-h-0 flex-1 flex-col gap-3"
            >
              <LiquidGlassCard
                webglSurface
                data-testid="task-overview-task-list-card"
                className="min-h-0 overflow-hidden rounded-[16px] border border-white/8 p-3 shadow-[0_10px_26px_-20px_rgb(20_26_40_/_45%)]"
                style={{ flex: "55 1 0%" }}
              >
                <TaskListPane
                  activeGroups={activeGroups}
                  completedGroups={completedGroups}
                  myTurnItems={myTurnItems}
                  selectedTaskId={effectiveSelectedTaskId}
                  completedGroupsOpen={completedGroupsOpen}
                  onSelectTask={setSelectedTaskId}
                  onToggleCompletedGroups={() => setCompletedGroupsOpen((value) => !value)}
                  onOpenTaskBoard={openGroupBoard}
                  onStatusChanged={refreshOverview}
                />
              </LiquidGlassCard>

              <LiquidGlassCard
                webglSurface
                data-testid="task-overview-selected-items-pane"
                className="min-h-0 overflow-hidden rounded-[16px] border border-white/8 p-3 shadow-[0_10px_26px_-20px_rgb(20_26_40_/_45%)]"
                style={{ flex: "45 1 0%" }}
              >
                <TaskItemsPane
                  group={selectedGroup}
                  onOpenBoard={openBoardItem}
                  onStatusChanged={refreshOverview}
                />
              </LiquidGlassCard>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
