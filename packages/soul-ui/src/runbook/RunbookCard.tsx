import { useEffect, useMemo, type PointerEvent } from "react";
import { BookOpen, ExternalLink } from "lucide-react";

import { DashboardIconCap } from "../components/DashboardIconCap";
import { LiquidGlassCard } from "../components/LiquidGlassCard";
import { cn } from "../lib/cn";
import {
  type RunbookItemRow,
  type RunbookSectionRow,
  useRunbookStore,
} from "../stores/runbook-store";
import { RunbookChecklist } from "./RunbookChecklist";
import { RunbookCompletionAction } from "./RunbookCompletionAction";

interface RunbookCardProps {
  runbookId: string;
  fallbackTitle: string;
  onOpenBoard?: (runbookId: string) => void;
  defaultItemDetailsOpen?: boolean;
  textSize?: "compact" | "session";
  editable?: boolean;
}

function stopTileDrag(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
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
      comparePositionKey(a.position_key, b.position_key) ||
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

function sortSections(sections: readonly RunbookSectionRow[]): RunbookSectionRow[] {
  return sections
    .filter((section) => !section.archived)
    .slice()
    .sort((a, b) =>
      comparePositionKey(a.position_key, b.position_key) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
    );
}

function comparePositionKey(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function RunbookCard({
  runbookId,
  fallbackTitle,
  onOpenBoard,
  defaultItemDetailsOpen = false,
  textSize = "compact",
  editable = false,
}: RunbookCardProps) {
  const projection = useRunbookStore((s) => s.byId[runbookId]);
  const loadRunbook = useRunbookStore((s) => s.loadRunbook);
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

      <div data-testid="runbook-card-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && !snapshot && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            불러오는 중
          </div>
        )}

        {error && !snapshot && (
          <div className="rounded-lg bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
            {error}
          </div>
        )}

        {!loading && !error && snapshot === null && (
          <div className="px-1 py-2 text-xs text-muted-foreground">
            런북을 찾을 수 없음
          </div>
        )}

        {snapshot && sections.length === 0 && !editable && (
          <div className="px-1 py-2 text-xs text-muted-foreground">
            항목 없음
          </div>
        )}

        {snapshot && (sections.length > 0 || editable) ? (
          <RunbookChecklist
            snapshot={snapshot}
            sections={sections}
            itemsBySection={itemsBySection}
            defaultItemDetailsOpen={defaultItemDetailsOpen}
            textSize={textSize}
            editable={editable}
          />
        ) : null}
      </div>
    </LiquidGlassCard>
  );
}
