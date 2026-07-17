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
  type RunbookOverviewGroup,
  type RunbookOverviewItem,
  useRunbookStore,
} from "../stores/runbook-store";
import { isRunbookCompleted } from "./RunbookCompletionAction";
import { RunbookOverviewRunningSessions } from "./RunbookOverviewRunningSessions";
import {
  RunbookItemsPane,
  RunbookListRow,
  countAttentionItems,
  runbookAttentionCounts,
} from "./RunbookOverviewRows";

function RunbookListPane({
  activeGroups,
  completedGroups,
  myTurnItems,
  selectedRunbookId,
  completedGroupsOpen,
  onSelectRunbook,
  onToggleCompletedGroups,
  onOpenRunbookBoard,
  onStatusChanged,
}: {
  activeGroups: RunbookOverviewGroup[];
  completedGroups: RunbookOverviewGroup[];
  myTurnItems: RunbookOverviewItem[];
  selectedRunbookId: string | null;
  completedGroupsOpen: boolean;
  onSelectRunbook: (runbookId: string) => void;
  onToggleCompletedGroups: () => void;
  onOpenRunbookBoard: (group: RunbookOverviewGroup) => void;
  onStatusChanged: () => Promise<void>;
}) {
  return (
    <section
      data-testid="runbook-overview-runbook-list-pane"
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">런북별 진행</h2>
        <Badge variant="outline" size="sm" className="h-5 px-1.5 text-[10px]">
          {activeGroups.length}
        </Badge>
      </div>
      <div
        data-testid="runbook-overview-runbook-list-scroll"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
      >
        {activeGroups.length > 0 ? (
          activeGroups.map((group) => (
            <RunbookListRow
              key={group.runbook_id}
              group={group}
              attention={runbookAttentionCounts(group, myTurnItems)}
              selected={selectedRunbookId === group.runbook_id}
              onSelect={() => onSelectRunbook(group.runbook_id)}
              onOpenRunbookBoard={onOpenRunbookBoard}
              onStatusChanged={onStatusChanged}
            />
          ))
        ) : (
          <div className="rounded-[14px] border border-dashed border-[var(--lg-line)] px-3 py-5 text-center text-sm text-muted-foreground">
            진행 중인 런북 없음
          </div>
        )}

        {completedGroups.length > 0 ? (
          <div
            data-testid="runbook-overview-completed-groups"
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
                  <RunbookListRow
                    key={group.runbook_id}
                    group={group}
                    attention={runbookAttentionCounts(group, myTurnItems)}
                    selected={selectedRunbookId === group.runbook_id}
                    onSelect={() => onSelectRunbook(group.runbook_id)}
                    onOpenRunbookBoard={onOpenRunbookBoard}
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

export function RunbookOverview() {
  const projection = useRunbookStore((s) => s.overview);
  const loadOverview = useRunbookStore((s) => s.loadOverview);
  const openRunbookBoard = useDashboardStore((s) => s.openRunbookBoard);
  const [selectedRunbookId, setSelectedRunbookId] = useState<string | null>(null);
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
    () => (snapshot?.runbooks ?? []).filter((group) => group.total_count > 0),
    [snapshot?.runbooks],
  );
  const activeGroups = useMemo(
    () => groups.filter((group) => !isRunbookCompleted(group.runbook_status)),
    [groups],
  );
  const completedGroups = useMemo(
    () => groups.filter((group) => isRunbookCompleted(group.runbook_status)),
    [groups],
  );
  const selectableGroups = useMemo(
    () => [...activeGroups, ...completedGroups],
    [activeGroups, completedGroups],
  );
  const effectiveSelectedRunbookId = useMemo(() => {
    if (
      selectedRunbookId &&
      selectableGroups.some((group) => group.runbook_id === selectedRunbookId)
    ) {
      return selectedRunbookId;
    }
    return selectableGroups[0]?.runbook_id ?? null;
  }, [selectableGroups, selectedRunbookId]);
  const selectedGroup = useMemo(
    () => selectableGroups.find((group) => group.runbook_id === effectiveSelectedRunbookId) ?? null,
    [effectiveSelectedRunbookId, selectableGroups],
  );
  const loading = projection.status === "loading";
  const refreshing = projection.isRefreshing;
  const error = projection.error;

  useEffect(() => {
    setSelectedRunbookId((current) => {
      if (selectableGroups.length === 0) return null;
      if (current && selectableGroups.some((group) => group.runbook_id === current)) {
        return current;
      }
      return selectableGroups[0].runbook_id;
    });
  }, [selectableGroups]);

  const openBoardItem = (item: RunbookOverviewItem) => {
    openRunbookBoard(item.runbook_id, item.folder_id);
  };

  const openGroupBoard = (group: RunbookOverviewGroup) => {
    openRunbookBoard(group.runbook_id, group.folder_id);
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
            <h1 className="truncate text-base font-semibold leading-6">런북</h1>
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
              data-testid="runbook-overview-dashboard"
              className="shrink-0 rounded-[16px] border border-accent-blue/30 p-3 shadow-[0_10px_26px_-20px_rgb(30_84_160_/_50%)]"
            >
              <RunbookOverviewRunningSessions />
            </LiquidGlassCard>

            <div
              data-testid="runbook-overview-split-layout"
              className="flex min-h-0 flex-1 flex-col gap-3"
            >
              <LiquidGlassCard
                webglSurface
                data-testid="runbook-overview-runbook-list-card"
                className="min-h-0 overflow-hidden rounded-[16px] border border-white/8 p-3 shadow-[0_10px_26px_-20px_rgb(20_26_40_/_45%)]"
                style={{ flex: "55 1 0%" }}
              >
                <RunbookListPane
                  activeGroups={activeGroups}
                  completedGroups={completedGroups}
                  myTurnItems={myTurnItems}
                  selectedRunbookId={effectiveSelectedRunbookId}
                  completedGroupsOpen={completedGroupsOpen}
                  onSelectRunbook={setSelectedRunbookId}
                  onToggleCompletedGroups={() => setCompletedGroupsOpen((value) => !value)}
                  onOpenRunbookBoard={openGroupBoard}
                  onStatusChanged={refreshOverview}
                />
              </LiquidGlassCard>

              <LiquidGlassCard
                webglSurface
                data-testid="runbook-overview-selected-items-pane"
                className="min-h-0 overflow-hidden rounded-[16px] border border-white/8 p-3 shadow-[0_10px_26px_-20px_rgb(20_26_40_/_45%)]"
                style={{ flex: "45 1 0%" }}
              >
                <RunbookItemsPane
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
