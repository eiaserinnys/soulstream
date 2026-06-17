import { useEffect, useMemo, useState, type ChangeEvent, type PointerEvent } from "react";
import {
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  MessageSquare,
  UserRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { MarkdownContent } from "../components/MarkdownContent";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import {
  type RunbookAssigneeKind,
  type RunbookItemRow,
  type RunbookItemStatus,
  type RunbookRow,
  type RunbookSectionRow,
  useRunbookStore,
} from "../stores/runbook-store";

interface RunbookCardProps {
  runbookId: string;
  fallbackTitle: string;
}

interface EffectiveAssignee {
  kind: RunbookAssigneeKind | null;
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
}

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
    icon: XCircle,
    className: "border-muted-foreground/25 text-muted-foreground",
  },
};

function stopTileDrag(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function isTerminal(status: RunbookItemStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function resolveAssignee(
  section: RunbookSectionRow,
  item: RunbookItemRow,
): EffectiveAssignee {
  if (item.assignee_kind) {
    return {
      kind: item.assignee_kind,
      agentId: item.assignee_agent_id,
      sessionId: item.assignee_session_id,
      userId: item.assignee_user_id,
    };
  }
  return {
    kind: section.assignee_kind,
    agentId: section.assignee_agent_id,
    sessionId: section.assignee_session_id,
    userId: section.assignee_user_id,
  };
}

function isHumanTurn(assignee: EffectiveAssignee, item: RunbookItemRow): boolean {
  return assignee.kind === "human" &&
    !item.archived &&
    item.status !== "completed" &&
    item.status !== "cancelled";
}

function isHumanWritable(assignee: EffectiveAssignee, item: RunbookItemRow): boolean {
  return assignee.kind === "human" &&
    !item.archived &&
    item.status !== "cancelled";
}

function resolveActorSessionId(
  runbook: RunbookRow,
  section: RunbookSectionRow,
  item: RunbookItemRow,
  assignee: EffectiveAssignee,
): string | null {
  return assignee.sessionId ||
    item.updated_session_id ||
    item.created_session_id ||
    section.updated_session_id ||
    section.created_session_id ||
    runbook.created_session_id ||
    null;
}

function createStatusIdempotencyKey(
  runbookId: string,
  itemId: string,
  status: Extract<RunbookItemStatus, "pending" | "completed" | "cancelled">,
  expectedVersion: number,
): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `runbook:${runbookId}:item:${itemId}:status:${status}:v${expectedVersion}:${randomId}`;
}

function assigneeLabel(assignee: EffectiveAssignee): string {
  if (assignee.kind === "human") return assignee.userId || "사람";
  if (assignee.kind === "agent") return assignee.agentId || "에이전트";
  if (assignee.kind === "session") return assignee.sessionId || "세션";
  return "미지정";
}

function AssigneeIcon({ assignee }: { assignee: EffectiveAssignee }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (assignee.kind === "human") return <UserRound className={className} aria-label="human" />;
  if (assignee.kind === "agent") return <Bot className={className} aria-label="agent" />;
  if (assignee.kind === "session") return <MessageSquare className={className} aria-label="session" />;
  return <Circle className={className} aria-label="unassigned" />;
}

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

function buildSectionItems(
  sections: readonly RunbookSectionRow[],
  items: readonly RunbookItemRow[],
): Map<string, RunbookItemRow[]> {
  const result = new Map(sections.map((section) => [section.id, [] as RunbookItemRow[]]));
  for (const item of items) {
    if (item.archived) continue;
    const sectionItems = result.get(item.section_id);
    if (sectionItems) sectionItems.push(item);
  }
  for (const sectionItems of result.values()) {
    sectionItems.sort((a, b) =>
      a.position_key.localeCompare(b.position_key) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
    );
  }
  return result;
}

function progressFor(
  sections: readonly RunbookSectionRow[],
  itemsBySection: Map<string, RunbookItemRow[]>,
): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const section of sections) {
    if (section.archived) continue;
    for (const item of itemsBySection.get(section.id) ?? []) {
      if (item.status === "cancelled") continue;
      total += 1;
      if (item.status === "completed") completed += 1;
    }
  }
  return { completed, total };
}

function sectionDefaultOpen(section: RunbookSectionRow, items: readonly RunbookItemRow[]): boolean {
  if (section.archived) return false;
  return items.some((item) => !isTerminal(item.status));
}

function itemDefaultOpen(
  section: RunbookSectionRow,
  item: RunbookItemRow,
): boolean {
  return isHumanTurn(resolveAssignee(section, item), item);
}

function sortSections(sections: readonly RunbookSectionRow[]): RunbookSectionRow[] {
  return sections
    .filter((section) => !section.archived)
    .slice()
    .sort((a, b) =>
      a.position_key.localeCompare(b.position_key) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
    );
}

export function RunbookCard({ runbookId, fallbackTitle }: RunbookCardProps) {
  const projection = useRunbookStore((s) => s.byId[runbookId]);
  const loadRunbook = useRunbookStore((s) => s.loadRunbook);
  const setItemStatus = useRunbookStore((s) => s.setItemStatus);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});
  const [pendingItems, setPendingItems] = useState<Record<string, boolean>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    void loadRunbook(runbookId, { signal: controller.signal });
    return () => controller.abort();
  }, [loadRunbook, runbookId]);

  const snapshot = projection?.snapshot ?? null;
  const sections = useMemo(
    () => sortSections(snapshot?.sections ?? []),
    [snapshot?.sections],
  );
  const itemsBySection = useMemo(
    () => buildSectionItems(sections, snapshot?.items ?? []),
    [sections, snapshot?.items],
  );
  const progress = useMemo(
    () => progressFor(sections, itemsBySection),
    [sections, itemsBySection],
  );
  const title = snapshot?.runbook.title || fallbackTitle || "Runbook";
  const loading = (projection?.status ?? "idle") === "loading";
  const refreshing = Boolean(projection?.isRefreshing);
  const error = projection?.error ?? null;

  const handleStatusChange = async (
    section: RunbookSectionRow,
    item: RunbookItemRow,
    assignee: EffectiveAssignee,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!snapshot) return;
    const actorSessionId = resolveActorSessionId(snapshot.runbook, section, item, assignee);
    if (!actorSessionId) return;
    const nextStatus: Extract<RunbookItemStatus, "pending" | "completed" | "cancelled"> =
      event.currentTarget.checked ? "completed" : "pending";
    setPendingItems((prev) => ({ ...prev, [item.id]: true }));
    setItemErrors((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      await setItemStatus({
        runbookId: snapshot.runbook.id,
        itemId: item.id,
        expectedVersion: item.version,
        status: nextStatus,
        idempotencyKey: createStatusIdempotencyKey(
          snapshot.runbook.id,
          item.id,
          nextStatus,
          item.version,
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setItemErrors((prev) => ({ ...prev, [item.id]: message }));
    } finally {
      setPendingItems((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] bg-[var(--lg-card)] text-left"
      onClick={(event) => event.stopPropagation()}
    >
      <header className="shrink-0 border-b border-[var(--lg-line)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent-blue" />
          <div className="min-w-0 flex-1">
            <div data-testid="runbook-card-title" className="truncate text-[13px] font-semibold leading-5">
              {title}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="runbook-card-progress">
                {progress.completed}/{progress.total}
              </span>
              {refreshing && <span>동기화 중</span>}
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading && !snapshot && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            불러오는 중
          </div>
        )}

        {error && !snapshot && (
          <div className="rounded-[12px] border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
            {error}
          </div>
        )}

        {!loading && !error && snapshot === null && (
          <div className="rounded-[12px] border border-[var(--lg-line)] px-3 py-2 text-xs text-muted-foreground">
            런북을 찾을 수 없음
          </div>
        )}

        {snapshot && sections.length === 0 && (
          <div className="rounded-[12px] border border-[var(--lg-line)] px-3 py-2 text-xs text-muted-foreground">
            항목 없음
          </div>
        )}

        {snapshot && sections.map((section) => {
          const sectionItems = itemsBySection.get(section.id) ?? [];
          const open = openSections[section.id] ?? sectionDefaultOpen(section, sectionItems);
          return (
            <section key={section.id} className="mb-2 last:mb-0">
              <button
                type="button"
                data-testid="runbook-section-toggle"
                className="flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60"
                onPointerDown={stopTileDrag}
                onClick={() =>
                  setOpenSections((prev) => ({ ...prev, [section.id]: !open }))
                }
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                <Badge variant="outline" size="sm" className="h-4 px-1 text-[10px]">
                  {sectionItems.length}
                </Badge>
              </button>

              {open && (
                <div className="mt-2 space-y-2">
                  {sectionItems.map((item) => {
                    const assignee = resolveAssignee(section, item);
                    const myTurn = isHumanTurn(assignee, item);
                    const writable = snapshot
                      ? isHumanWritable(assignee, item) &&
                        Boolean(resolveActorSessionId(snapshot.runbook, section, item, assignee))
                      : false;
                    const pending = Boolean(pendingItems[item.id]);
                    const itemError = itemErrors[item.id];
                    const itemOpen = openItems[item.id] ?? itemDefaultOpen(section, item);
                    const hasHowTo = item.how_to.trim().length > 0;
                    return (
                      <div
                        key={item.id}
                        data-testid="runbook-item-row"
                        className={cn(
                          "rounded-[12px] border border-white/8 bg-background/25 px-2.5 py-2 shadow-[0_6px_18px_-18px_rgb(20_26_40_/_45%)]",
                          myTurn && "border-accent-blue/70 bg-accent-blue/[0.14] shadow-[0_0_0_1px_rgb(73_146_255_/_28%)]",
                          item.status === "cancelled" && "opacity-70",
                        )}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <input
                            type="checkbox"
                            checked={item.status === "completed"}
                            disabled={!writable || pending}
                            title={item.status === "completed" ? "완료 해제" : "완료 표시"}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent-blue"
                            onPointerDown={stopTileDrag}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => void handleStatusChange(section, item, assignee, event)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  "min-w-0 flex-1 truncate text-xs font-medium leading-5",
                                  item.status === "cancelled" && "line-through",
                                )}
                              >
                                {item.title}
                              </span>
                              {myTurn && (
                                <Badge variant="info" size="sm" className="h-4 px-1 text-[10px]">
                                  내 차례
                                </Badge>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              <StatusChip status={item.status} />
                              <span
                                className={cn(
                                  "inline-flex h-5 min-w-0 items-center gap-1 rounded-full border border-[var(--lg-line)] px-1.5",
                                  myTurn && "border-accent-blue/40 text-accent-blue",
                                )}
                                title={assigneeLabel(assignee)}
                              >
                                <AssigneeIcon assignee={assignee} />
                                <span className="max-w-[96px] truncate">{assigneeLabel(assignee)}</span>
                              </span>
                              {hasHowTo && (
                                <button
                                  type="button"
                                  className="ml-auto inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[10px] text-accent-blue hover:bg-accent-blue/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60"
                                  onPointerDown={stopTileDrag}
                                  onClick={() =>
                                    setOpenItems((prev) => ({ ...prev, [item.id]: !itemOpen }))
                                  }
                                >
                                  {itemOpen ? (
                                    <ChevronDown className="h-3 w-3" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3" />
                                  )}
                                  절차
                                </button>
                              )}
                            </div>
                            {hasHowTo && itemOpen && (
                              <div
                                data-testid="runbook-how-to"
                                className="mt-2 rounded-[10px] border border-[var(--lg-line)] bg-background/40 px-2.5 py-2 text-xs leading-relaxed text-foreground"
                              >
                                <MarkdownContent content={item.how_to} compact />
                              </div>
                            )}
                            {itemError && (
                              <div className="mt-1 text-[10px] leading-4 text-accent-red">
                                {itemError}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
