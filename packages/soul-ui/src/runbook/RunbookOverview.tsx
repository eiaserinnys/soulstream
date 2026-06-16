import { useEffect, useMemo, useState } from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  ListChecks,
  RefreshCw,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  type RunbookItemStatus,
  type RunbookOverviewGroup,
  type RunbookOverviewItem,
  useRunbookStore,
} from "../stores/runbook-store";

const statusConfig: Record<RunbookItemStatus, {
  label: string;
  icon: LucideIcon;
  className: string;
}> = {
  pending: {
    label: "대기",
    icon: Circle,
    className: "border-muted-foreground/30 text-muted-foreground",
  },
  in_progress: {
    label: "진행",
    icon: Clock3,
    className: "border-accent-blue/35 bg-accent-blue/10 text-accent-blue",
  },
  completed: {
    label: "완료",
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  cancelled: {
    label: "취소",
    icon: Circle,
    className: "border-muted-foreground/25 text-muted-foreground",
  },
};

function StatusChip({ status }: { status: RunbookItemStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[10px] font-semibold",
        config.className,
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function assigneeLabel(item: RunbookOverviewItem): string {
  return item.effective_assignee_user_id || "사람";
}

function itemSubtitle(item: RunbookOverviewItem): string {
  return `${item.runbook_title} / ${item.section_title}`;
}

function isDone(item: RunbookOverviewItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function progressText(group: RunbookOverviewGroup): string {
  return `${group.completed_count}/${group.total_count}`;
}

function MyTurnItemButton({
  item,
  onNavigate,
}: {
  item: RunbookOverviewItem;
  onNavigate: (item: RunbookOverviewItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid="runbook-overview-my-turn-item"
      className="group flex w-full min-w-0 items-start gap-3 rounded-md border border-accent-blue/55 bg-accent-blue/[0.14] px-3 py-2.5 text-left shadow-[0_0_0_1px_rgb(73_146_255_/_22%)] transition-colors hover:bg-accent-blue/[0.20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/55"
      onClick={() => onNavigate(item)}
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-blue/18 text-accent-blue">
        <UserRound className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-5 text-foreground">
          {item.item_title}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {itemSubtitle(item)}
        </span>
        <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <StatusChip status={item.status} />
          <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
            {assigneeLabel(item)}
          </Badge>
        </span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-accent-blue transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function GroupItemButton({
  item,
  onNavigate,
}: {
  item: RunbookOverviewItem;
  onNavigate: (item: RunbookOverviewItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid="runbook-overview-group-item"
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-md border border-[var(--lg-line)] bg-muted/[0.10] px-2.5 py-2 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50",
        isDone(item) && "opacity-70",
      )}
      onClick={() => onNavigate(item)}
    >
      <span className="mt-0.5 shrink-0">
        <StatusChip status={item.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn(
          "block truncate text-xs font-medium leading-5 text-foreground",
          isDone(item) && "line-through",
        )}>
          {item.item_title}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {item.section_title}
        </span>
      </span>
      {item.effective_assignee_kind === "human" && !isDone(item) ? (
        <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
          사람
        </Badge>
      ) : null}
    </button>
  );
}

function RunbookGroup({
  group,
  open,
  onToggle,
  onNavigateRunbook,
  onNavigateItem,
}: {
  group: RunbookOverviewGroup;
  open: boolean;
  onToggle: () => void;
  onNavigateRunbook: (group: RunbookOverviewGroup) => void;
  onNavigateItem: (item: RunbookOverviewItem) => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="rounded-md border border-[var(--lg-line)] bg-[var(--lg-card)]">
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-2">
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
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50"
          onClick={() => onNavigateRunbook(group)}
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
      </div>
      {open ? (
        <div className="space-y-1.5 border-t border-[var(--lg-line)] px-2 py-2">
          {group.items.length > 0 ? (
            group.items.map((item) => (
              <GroupItemButton
                key={item.item_id}
                item={item}
                onNavigate={onNavigateItem}
              />
            ))
          ) : (
            <div className="rounded-sm border border-dashed border-[var(--lg-line)] px-2 py-2 text-xs text-muted-foreground">
              표시할 항목 없음
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function RunbookOverview() {
  const projection = useRunbookStore((s) => s.overview);
  const loadOverview = useRunbookStore((s) => s.loadOverview);
  const focusBoardItem = useDashboardStore((s) => s.focusBoardItem);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const controller = new AbortController();
    void loadOverview({ signal: controller.signal });
    return () => controller.abort();
  }, [loadOverview]);

  const snapshot = projection.snapshot;
  const myTurnItems = snapshot?.my_turn_items ?? [];
  const groups = useMemo(
    () => (snapshot?.runbooks ?? []).filter((group) => group.total_count > 0),
    [snapshot?.runbooks],
  );
  const loading = projection.status === "loading";
  const refreshing = projection.isRefreshing;
  const error = projection.error;

  const navigateItem = (item: RunbookOverviewItem) => {
    focusBoardItem(item.board_item_id, item.folder_id ?? null);
  };
  const navigateRunbook = (group: RunbookOverviewGroup) => {
    focusBoardItem(group.board_item_id, group.folder_id ?? null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/35">
      <header className="shrink-0 border-b border-[var(--lg-line)] bg-[var(--lg-card)] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-blue/14 text-accent-blue">
            <BookOpenCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-6">런북</h1>
            <p className="truncate text-xs text-muted-foreground">
              내 차례 {myTurnItems.length}개 · 런북 {groups.length}개
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

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <section
              data-testid="runbook-overview-my-turn"
              className="rounded-md border border-accent-blue/60 bg-[var(--lg-card)] p-3 shadow-[0_0_0_1px_rgb(73_146_255_/_18%)]"
            >
              <div className="mb-3 flex min-w-0 items-center gap-2">
                <UserRound className="h-4 w-4 shrink-0 text-accent-blue" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">내 차례</h2>
                <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
                  {myTurnItems.length}
                </Badge>
              </div>
              {myTurnItems.length > 0 ? (
                <div className="grid gap-2 lg:grid-cols-2">
                  {myTurnItems.map((item) => (
                    <MyTurnItemButton
                      key={`${item.runbook_id}:${item.item_id}`}
                      item={item}
                      onNavigate={navigateItem}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-accent-blue/30 px-3 py-6 text-center text-sm text-muted-foreground">
                  지금 사람이 이어받을 항목이 없음
                </div>
              )}
            </section>

            <section className="flex min-h-0 flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2 px-1">
                <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">런북별 진행</h2>
              </div>
              {groups.length > 0 ? (
                <div className="space-y-2">
                  {groups.map((group) => {
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
                        onNavigateRunbook={navigateRunbook}
                        onNavigateItem={navigateItem}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-[var(--lg-line)] bg-[var(--lg-card)] px-3 py-6 text-center text-sm text-muted-foreground">
                  표시할 런북이 없음
                </div>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
