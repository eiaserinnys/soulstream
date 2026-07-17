import { useEffect, useMemo, useState, type PointerEvent } from "react";
import {
  Bot,
  BookOpen,
  Circle,
  ExternalLink,
  MessageSquare,
  UserRound,
} from "lucide-react";

import { MarkdownContent } from "../components/MarkdownContent";
import { DashboardIconCap } from "../components/DashboardIconCap";
import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { LiquidGlassCard } from "../components/LiquidGlassCard";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import {
  type RunbookAssigneeKind,
  type RunbookItemRow,
  type RunbookItemStatus,
  type RunbookSectionRow,
  useRunbookStore,
} from "../stores/runbook-store";
import {
  RunbookItemStatusToggle,
  isRunbookItemHumanTurn,
  runbookAssigneeLabel,
  type RunbookStatusToggleItem,
  type RunbookStatusToggleRunbook,
  type RunbookStatusToggleSection,
} from "./RunbookItemStatusToggle";
import { RunbookCompletionAction } from "./RunbookCompletionAction";

interface RunbookCardProps {
  runbookId: string;
  fallbackTitle: string;
  onOpenBoard?: (runbookId: string) => void;
  defaultItemDetailsOpen?: boolean;
  textSize?: "compact" | "session";
}

interface EffectiveAssignee {
  kind: RunbookAssigneeKind | null;
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
}

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

function AssigneeIcon({ assignee }: { assignee: EffectiveAssignee }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (assignee.kind === "human") return <UserRound className={className} aria-label="human" />;
  if (assignee.kind === "agent") return <Bot className={className} aria-label="agent" />;
  if (assignee.kind === "session") return <MessageSquare className={className} aria-label="session" />;
  return <Circle className={className} aria-label="unassigned" />;
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
  defaultItemDetailsOpen: boolean,
): boolean {
  return defaultItemDetailsOpen
    || isRunbookItemHumanTurn(resolveAssignee(section, item), toToggleItem(item));
}

function toToggleRunbook(runbookId: string, createdSessionId: string | null): RunbookStatusToggleRunbook {
  return {
    id: runbookId,
    createdSessionId,
  };
}

function toToggleSection(section: RunbookSectionRow): RunbookStatusToggleSection {
  return {
    createdSessionId: section.created_session_id,
    updatedSessionId: section.updated_session_id,
  };
}

function toToggleItem(item: RunbookItemRow): RunbookStatusToggleItem {
  return {
    id: item.id,
    status: item.status,
    archived: item.archived,
    version: item.version,
    createdSessionId: item.created_session_id,
    updatedSessionId: item.updated_session_id,
  };
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

export function RunbookCard({
  runbookId,
  fallbackTitle,
  onOpenBoard,
  defaultItemDetailsOpen = false,
  textSize = "compact",
}: RunbookCardProps) {
  const projection = useRunbookStore((s) => s.byId[runbookId]);
  const loadRunbook = useRunbookStore((s) => s.loadRunbook);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});

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

  return (
    <LiquidGlassCard
      webglSurface
      data-testid="runbook-card"
      data-text-size={textSize}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-white/8 text-left shadow-[0_10px_30px_-18px_rgb(10_16_30_/_50%)]"
      onClick={(event) => event.stopPropagation()}
    >
      <header className="shrink-0 border-b border-[var(--lg-line)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent-blue" />
          <div className="min-w-0 flex-1">
            <div
              data-testid="runbook-card-title"
              className={cn(
                "truncate font-semibold leading-5",
                textSize === "session" ? "text-[14.5px]" : "text-[13px]",
              )}
            >
              {title}
            </div>
            <div className={cn(
              "mt-1 flex items-center gap-2 text-muted-foreground",
              textSize === "session" ? "text-xs" : "text-[11px]",
            )}>
              <span data-testid="runbook-card-progress">
                {progress.completed}/{progress.total}
              </span>
              {refreshing && <span>동기화 중</span>}
            </div>
          </div>
          {snapshot ? (
            <RunbookCompletionAction
              runbook={{
                id: snapshot.runbook.id,
                title,
                status: snapshot.runbook.status,
                version: snapshot.runbook.version,
              }}
              buttonClassName="px-2 text-[11px]"
            />
          ) : null}
          {onOpenBoard ? (
            <DashboardIconCap
              label={`${title} 런북 보드 열기`}
              data-testid="runbook-card-open-board"
              className="shrink-0"
              onPointerDown={stopTileDrag}
              onClick={(event) => {
                event.stopPropagation();
                onOpenBoard(runbookId);
              }}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </DashboardIconCap>
          ) : null}
        </div>
      </header>

      <div data-testid="runbook-card-scroll" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
          const open = openSections[section.id]
            ?? (defaultItemDetailsOpen || sectionDefaultOpen(section, sectionItems));
          return (
            <section key={section.id} className="mb-2 last:mb-0">
              <button
                type="button"
                data-testid="runbook-section-toggle"
                aria-expanded={open}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left font-semibold text-foreground transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60",
                  textSize === "session" ? "text-sm" : "text-xs",
                )}
                onPointerDown={stopTileDrag}
                onClick={() =>
                  setOpenSections((prev) => ({ ...prev, [section.id]: !open }))
                }
              >
                <DisclosureActionIcon
                  expanded={open}
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                <Badge
                  variant="outline"
                  size="sm"
                  className={cn("h-4 px-1", textSize === "session" ? "text-xs" : "text-[10px]")}
                >
                  {sectionItems.length}
                </Badge>
              </button>

              {open && (
                <div className="mt-2 space-y-2">
                  {sectionItems.map((item) => {
                    const assignee = resolveAssignee(section, item);
                    const toggleItem = toToggleItem(item);
                    const myTurn = isRunbookItemHumanTurn(assignee, toggleItem);
                    const itemOpen = openItems[item.id]
                      ?? itemDefaultOpen(section, item, defaultItemDetailsOpen);
                    const hasHowTo = item.how_to.trim().length > 0;
                    return (
                      <div
                        key={item.id}
                        data-testid="runbook-item-row"
                        className={cn(
                          "rounded-[12px] border border-glass-border glass glass-shadow-xs px-2.5 py-2",
                          myTurn && "border-accent-blue/60 glass-strong shadow-[0_0_0_1px_rgb(73_146_255_/_28%)]",
                          item.status === "cancelled" && "opacity-70",
                        )}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <RunbookItemStatusToggle
                            runbook={toToggleRunbook(snapshot.runbook.id, snapshot.runbook.created_session_id)}
                            section={toToggleSection(section)}
                            item={toggleItem}
                            assignee={assignee}
                            controlClassName={cn(myTurn && "border-accent-blue/45 text-accent-blue")}
                            onPointerDown={stopTileDrag}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                data-testid="runbook-item-title"
                                className={cn(
                                  "min-w-0 flex-1 truncate font-medium",
                                  textSize === "session" ? "text-[14.5px] leading-[1.45]" : "text-xs leading-5",
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
                            <div className={cn(
                              "mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground",
                              textSize === "session" ? "text-xs" : "text-[10px]",
                            )}>
                              <span
                                className={cn(
                                  "inline-flex h-5 min-w-0 items-center gap-1 rounded-full border border-glass-border glass px-1.5",
                                  myTurn && "border-accent-blue/40 text-accent-blue",
                                )}
                                title={runbookAssigneeLabel(assignee)}
                              >
                                <AssigneeIcon assignee={assignee} />
                                <span className="max-w-[96px] truncate">{runbookAssigneeLabel(assignee)}</span>
                              </span>
                              {hasHowTo && (
                                <button
                                  type="button"
                                  aria-expanded={itemOpen}
                                  className={cn(
                                    "ml-auto inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-accent-blue hover:bg-accent-blue/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60",
                                    textSize === "session" ? "text-xs" : "text-[10px]",
                                  )}
                                  onPointerDown={stopTileDrag}
                                  onClick={() =>
                                    setOpenItems((prev) => ({ ...prev, [item.id]: !itemOpen }))
                                  }
                                >
                                  <DisclosureActionIcon expanded={itemOpen} className="h-3 w-3" />
                                  절차
                                </button>
                              )}
                            </div>
                            {hasHowTo && itemOpen && (
                              <div
                                data-testid="runbook-how-to"
                                className={cn(
                                  "mt-2 rounded-[10px] border border-glass-border glass px-2.5 py-2 leading-relaxed text-foreground glass-shadow-xs",
                                  textSize === "session" ? "text-sm" : "text-xs",
                                )}
                              >
                                <MarkdownContent content={item.how_to} compact />
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
    </LiquidGlassCard>
  );
}
