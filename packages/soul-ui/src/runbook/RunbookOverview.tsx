import { useEffect, useMemo, useState } from "react";
import {
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  ListChecks,
  RefreshCw,
  UserRound,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { DASHBOARD_LIST_INSET_PX } from "../components/dashboard-spacing";
import { LiquidGlassCard } from "../components/LiquidGlassCard";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "../components/ui/preview-card";
import { cn } from "../lib/cn";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  type RunbookOverviewGroup,
  type RunbookOverviewItem,
  useRunbookStore,
} from "../stores/runbook-store";
import { MarkdownContent } from "../components/MarkdownContent";
import {
  RunbookItemStatusToggle,
  isRunbookItemReview,
  isRunbookItemTerminal,
  runbookAssigneeLabel,
  type RunbookStatusToggleAssignee,
  type RunbookStatusToggleItem,
  type RunbookStatusToggleRunbook,
  type RunbookStatusToggleSection,
} from "./RunbookItemStatusToggle";
import {
  RunbookCompletionAction,
  isRunbookCompleted,
} from "./RunbookCompletionAction";
import { RunbookOverviewRunningSessions } from "./RunbookOverviewRunningSessions";

function toOverviewAssignee(item: RunbookOverviewItem): RunbookStatusToggleAssignee {
  return {
    kind: item.effective_assignee_kind,
    agentId: item.effective_assignee_agent_id,
    sessionId: item.effective_assignee_session_id,
    userId: item.effective_assignee_user_id,
  };
}

function toOverviewRunbook(item: RunbookOverviewItem): RunbookStatusToggleRunbook {
  return {
    id: item.runbook_id,
    createdSessionId: item.runbook_created_session_id,
  };
}

function toOverviewSection(item: RunbookOverviewItem): RunbookStatusToggleSection {
  return {
    createdSessionId: item.section_created_session_id,
    updatedSessionId: item.section_updated_session_id,
  };
}

function toOverviewItem(item: RunbookOverviewItem): RunbookStatusToggleItem {
  return {
    id: item.item_id,
    status: item.status,
    archived: false,
    version: item.item_version,
    createdSessionId: item.item_created_session_id,
    updatedSessionId: item.item_updated_session_id,
  };
}

function assigneeLabel(item: RunbookOverviewItem): string {
  return runbookAssigneeLabel(toOverviewAssignee(item));
}

function itemSubtitle(item: RunbookOverviewItem): string {
  return `${item.runbook_title} / ${item.section_title}`;
}

function isDone(item: RunbookOverviewItem): boolean {
  return isRunbookItemTerminal(item.status);
}

function isTodoItem(item: RunbookOverviewItem): boolean {
  return item.effective_assignee_kind === "human" &&
    (item.status === "pending" || item.status === "in_progress");
}

function progressText(group: RunbookOverviewGroup): string {
  return `${group.completed_count}/${group.total_count}`;
}

function OpenBoardButton({
  item,
  onOpenBoard,
}: {
  item: RunbookOverviewItem;
  onOpenBoard: (item: RunbookOverviewItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid="runbook-overview-open-board"
      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-blue/10 hover:text-accent-blue focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/55"
      title="보드에서 열기"
      aria-label={`${item.item_title} 보드에서 열기`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenBoard(item);
      }}
    >
      <ExternalLink className="h-4 w-4" />
    </button>
  );
}

function RunbookHowToPreview({
  item,
  className,
}: {
  item: RunbookOverviewItem;
  className?: string;
}) {
  const howTo = item.how_to.trim();
  if (!howTo) {
    return null;
  }

  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={<button type="button" />}
        data-testid="runbook-overview-item-how-to-trigger"
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-blue/10 hover:text-accent-blue focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50",
          className,
        )}
        aria-label={`${item.item_title} 상세 절차`}
        delay={250}
        closeDelay={150}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PreviewCardTrigger>
      <PreviewCardPopup
        data-testid="runbook-overview-item-how-to"
        align="start"
        sideOffset={8}
        className="max-h-[min(28rem,calc(100vh-6rem))] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-[12px] p-3 text-xs leading-relaxed"
      >
        <MarkdownContent content={howTo} compact />
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function MyTurnItemRow({
  item,
  tone,
  onOpenBoard,
  onStatusChanged,
}: {
  item: RunbookOverviewItem;
  tone: "todo" | "review";
  onOpenBoard: (item: RunbookOverviewItem) => void;
  onStatusChanged: () => Promise<void>;
}) {
  const assignee = toOverviewAssignee(item);
  const review = tone === "review";
  return (
    <div
      data-testid="runbook-overview-my-turn-item"
      className={cn(
        "group flex h-full w-[22rem] max-w-[calc(100vw-4rem)] flex-none snap-start flex-col gap-3 overflow-hidden rounded-[14px] border glass px-3 py-3 text-left glass-shadow-xs",
        "transition-colors focus-within:ring-1",
        review
          ? "border-warning/45 hover:border-warning/65 focus-within:ring-warning/35"
          : "border-accent-blue/45 hover:border-accent-blue/65 focus-within:ring-accent-blue/35",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <RunbookItemStatusToggle
          runbook={toOverviewRunbook(item)}
          section={toOverviewSection(item)}
          item={toOverviewItem(item)}
          assignee={assignee}
          className="shrink-0"
          controlClassName={
            review
              ? "border-warning/35 text-warning-foreground"
              : "border-accent-blue/35 text-accent-blue"
          }
          captionClassName="max-w-32"
          onStatusChanged={onStatusChanged}
        />
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="block min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-foreground">
              {item.item_title}
            </span>
            <RunbookHowToPreview item={item} />
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {itemSubtitle(item)}
          </span>
          <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge
              variant={review ? "warning" : "info"}
              size="sm"
              className="h-5 px-1.5 text-[10px]"
            >
              {review ? "확인 대기" : "할 일"}
            </Badge>
            <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
              {assigneeLabel(item)}
            </Badge>
          </span>
        </div>
        <OpenBoardButton item={item} onOpenBoard={onOpenBoard} />
      </div>
    </div>
  );
}

function MyTurnRailLabel({
  tone,
  count,
}: {
  tone: "todo" | "review";
  count: number;
}) {
  const review = tone === "review";
  return (
    <div
      data-testid={`runbook-overview-my-turn-${tone}-label`}
      className={cn(
        "flex h-full w-24 flex-none snap-start flex-col justify-between rounded-[14px] border glass px-3 py-3 text-left glass-shadow-xs",
        review
          ? "border-warning/35 text-warning-foreground"
          : "border-accent-blue/35 text-accent-blue",
      )}
    >
      <span className="text-xs font-semibold leading-5">
        {review ? "확인 대기" : "할 일"}
      </span>
      <Badge
        variant={review ? "warning" : "info"}
        size="sm"
        className="h-5 self-start px-1.5 text-[10px]"
      >
        {count}
      </Badge>
    </div>
  );
}

function GroupItemRow({
  item,
  onOpenBoard,
  onStatusChanged,
}: {
  item: RunbookOverviewItem;
  onOpenBoard: (item: RunbookOverviewItem) => void;
  onStatusChanged: () => Promise<void>;
}) {
  const assignee = toOverviewAssignee(item);
  return (
    <div
      data-testid="runbook-overview-group-item"
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-[12px] border border-glass-border glass px-2.5 py-2 text-left glass-shadow-xs transition-colors hover:border-accent-blue/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50",
        isDone(item) && "opacity-70",
      )}
    >
      <RunbookItemStatusToggle
        runbook={toOverviewRunbook(item)}
        section={toOverviewSection(item)}
        item={toOverviewItem(item)}
        assignee={assignee}
        className="shrink-0"
        controlClassName="min-h-9 gap-1.5 px-1.5"
        chipClassName="h-5 px-1.5 text-[10px]"
        captionClassName="max-w-28"
        showCaption={item.effective_assignee_kind === "human"}
        onStatusChanged={onStatusChanged}
      />
      <div className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={cn(
              "block min-w-0 flex-1 truncate text-xs font-medium leading-5 text-foreground",
              isDone(item) && "line-through",
            )}
          >
            {item.item_title}
          </span>
          <RunbookHowToPreview item={item} className="h-5 w-5" />
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {item.section_title}
        </span>
      </div>
      {item.effective_assignee_kind === "human" && !isDone(item) ? (
        <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
          사람
        </Badge>
      ) : null}
      <OpenBoardButton item={item} onOpenBoard={onOpenBoard} />
    </div>
  );
}

function RunbookGroup({
  group,
  open,
  onToggle,
  onOpenBoard,
  onStatusChanged,
}: {
  group: RunbookOverviewGroup;
  open: boolean;
  onToggle: () => void;
  onOpenBoard: (item: RunbookOverviewItem) => void;
  onStatusChanged: () => Promise<void>;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <LiquidGlassCard
      webglSurface
      data-testid="runbook-overview-group"
      className="rounded-[18px] border border-white/8 shadow-[0_10px_30px_-22px_rgb(20_26_40_/_55%)]"
    >
      <div className="flex min-w-0 items-center gap-1.5 px-3 py-2.5">
        <button
          type="button"
          data-testid="runbook-overview-group-toggle"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50"
          aria-label={open ? "접기" : "펼치기"}
          onClick={onToggle}
        >
          <Chevron className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="runbook-overview-group-link"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1.5 py-1 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50"
          onClick={onToggle}
        >
          <BookOpenCheck className="h-4 w-4 shrink-0 text-accent-blue" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-5">
              {group.runbook_title}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              진척 {progressText(group)}
            </span>
          </span>
          <Badge variant="outline" size="sm" className="h-5 px-1.5 text-[10px]">
            {progressText(group)}
          </Badge>
        </button>
        <RunbookCompletionAction
          runbook={{
            id: group.runbook_id,
            title: group.runbook_title,
            status: group.runbook_status,
            version: group.runbook_version ?? null,
          }}
          buttonClassName="px-2 text-[11px]"
          onStatusChanged={onStatusChanged}
        />
      </div>
      {open ? (
        <div className="space-y-2 border-t border-[var(--lg-line)] px-3 py-3">
          {group.items.length > 0 ? (
            group.items.map((item) => (
              <GroupItemRow
                key={item.item_id}
                item={item}
                onOpenBoard={onOpenBoard}
                onStatusChanged={onStatusChanged}
              />
            ))
          ) : (
            <div className="rounded-[12px] border border-dashed border-[var(--lg-line)] px-3 py-3 text-xs text-muted-foreground">
              표시할 항목 없음
            </div>
          )}
        </div>
      ) : null}
    </LiquidGlassCard>
  );
}

export function RunbookOverview() {
  const projection = useRunbookStore((s) => s.overview);
  const loadOverview = useRunbookStore((s) => s.loadOverview);
  const openRunbookBoard = useDashboardStore((s) => s.openRunbookBoard);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [completedGroupsOpen, setCompletedGroupsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadOverview({ signal: controller.signal });
    return () => controller.abort();
  }, [loadOverview]);

  const snapshot = projection.snapshot;
  const myTurnItems = snapshot?.my_turn_items ?? [];
  const todoItems = useMemo(
    () => myTurnItems.filter(isTodoItem),
    [myTurnItems],
  );
  const reviewItems = useMemo(
    () => myTurnItems.filter((item) => isRunbookItemReview(item.status)),
    [myTurnItems],
  );
  const myTurnDisplayCount = todoItems.length + reviewItems.length;
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
  const loading = projection.status === "loading";
  const refreshing = projection.isRefreshing;
  const error = projection.error;

  const openBoardItem = (item: RunbookOverviewItem) => {
    openRunbookBoard(item.runbook_id, item.folder_id);
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
        className="min-h-0 flex-1 overflow-y-auto"
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
          <div className="flex w-full flex-col gap-4">
            <LiquidGlassCard
              webglSurface
              data-testid="runbook-overview-dashboard"
              className="rounded-[18px] border border-accent-blue/35 p-4 shadow-[0_12px_32px_-22px_rgb(30_84_160_/_55%)]"
            >
              <div className="mb-4 flex min-w-0 items-center gap-2">
                <BookOpenCheck className="h-4 w-4 shrink-0 text-accent-blue" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">현황판</h2>
              </div>
              <div className="grid gap-5">
                <RunbookOverviewRunningSessions />

                <section data-testid="runbook-overview-my-turn" className="min-w-0">
                  <div className="mb-3 flex min-w-0 items-center gap-2">
                    <UserRound className="h-4 w-4 shrink-0 text-accent-blue" />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">내가 확인할 체크리스트</h2>
                    <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
                      {myTurnDisplayCount}
                    </Badge>
                  </div>
                  {myTurnDisplayCount > 0 ? (
                    <div
                      data-testid="runbook-overview-my-turn-rail"
                      className="flex h-[12.75rem] min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden pb-2 [scrollbar-gutter:stable]"
                    >
                      {todoItems.length > 0 ? (
                        <MyTurnRailLabel tone="todo" count={todoItems.length} />
                      ) : null}
                      {todoItems.map((item) => (
                        <MyTurnItemRow
                          key={`${item.runbook_id}:${item.item_id}`}
                          item={item}
                          tone="todo"
                          onOpenBoard={openBoardItem}
                          onStatusChanged={refreshOverview}
                        />
                      ))}
                      {reviewItems.length > 0 ? (
                        <MyTurnRailLabel tone="review" count={reviewItems.length} />
                      ) : null}
                      {reviewItems.map((item) => (
                        <MyTurnItemRow
                          key={`${item.runbook_id}:${item.item_id}`}
                          item={item}
                          tone="review"
                          onOpenBoard={openBoardItem}
                          onStatusChanged={refreshOverview}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[14px] border border-dashed border-accent-blue/30 px-3 py-6 text-center text-sm text-muted-foreground">
                      지금 사람이 이어받을 항목이 없음
                    </div>
                  )}
                </section>
              </div>
            </LiquidGlassCard>

            <section className="flex min-h-0 flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2 px-1">
                <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">런북별 진행</h2>
              </div>
              {activeGroups.length > 0 ? (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
                  {activeGroups.map((group) => {
                    const open = openGroups[group.runbook_id] ?? false;
                    return (
                      <RunbookGroup
                        key={group.runbook_id}
                        group={group}
                        open={open}
                        onToggle={() =>
                          setOpenGroups((prev) => ({
                            ...prev,
                            [group.runbook_id]: !open,
                          }))
                        }
                        onOpenBoard={openBoardItem}
                        onStatusChanged={refreshOverview}
                      />
                    );
                  })}
                </div>
              ) : (
                <LiquidGlassCard
                  webglSurface
                  className="rounded-[18px] border border-dashed border-[var(--lg-line)] px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  진행 중인 런북 없음
                </LiquidGlassCard>
              )}

              {completedGroups.length > 0 ? (
                <LiquidGlassCard
                  webglSurface
                  data-testid="runbook-overview-completed-groups"
                  className="rounded-[18px] border border-white/8 shadow-[0_10px_30px_-22px_rgb(20_26_40_/_55%)]"
                >
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left"
                    onClick={() => setCompletedGroupsOpen((value) => !value)}
                  >
                    {completedGroupsOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">완료됨</span>
                    <Badge variant="success" size="sm" className="h-5 px-1.5 text-[10px]">
                      {completedGroups.length}
                    </Badge>
                  </button>
                  {completedGroupsOpen ? (
                    <div className="grid gap-3 border-t border-[var(--lg-line)] px-3 py-3 [grid-template-columns:repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
                      {completedGroups.map((group) => {
                        const open = openGroups[group.runbook_id] ?? false;
                        return (
                          <RunbookGroup
                            key={group.runbook_id}
                            group={group}
                            open={open}
                            onToggle={() =>
                              setOpenGroups((prev) => ({
                                ...prev,
                                [group.runbook_id]: !open,
                              }))
                            }
                            onOpenBoard={openBoardItem}
                            onStatusChanged={refreshOverview}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </LiquidGlassCard>
              ) : null}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
