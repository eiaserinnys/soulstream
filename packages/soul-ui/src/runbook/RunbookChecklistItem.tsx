import type { PointerEvent } from "react";
import { Bot, Circle, MessageSquare, UserRound } from "lucide-react";

import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { MarkdownContent } from "../components/MarkdownContent";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import type {
  RunbookAssigneeKind,
  RunbookItemRow,
  RunbookSectionRow,
  RunbookSnapshot,
} from "../stores/runbook-store";
import { RunbookRowActions, type RowAction } from "./RunbookChecklistControls";
import {
  RunbookItemStatusToggle,
  isRunbookItemHumanTurn,
  runbookAssigneeLabel,
  type RunbookStatusToggleItem,
  type RunbookStatusToggleRunbook,
  type RunbookStatusToggleSection,
} from "./RunbookItemStatusToggle";

interface EffectiveAssignee {
  kind: RunbookAssigneeKind | null;
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
}

export function RunbookItemRowView({
  snapshot,
  section,
  item,
  itemOpen,
  textSize,
  actions,
  onToggleHowTo,
}: {
  snapshot: RunbookSnapshot;
  section: RunbookSectionRow;
  item: RunbookItemRow;
  itemOpen: boolean;
  textSize: "compact" | "session";
  actions: readonly RowAction[] | null;
  onToggleHowTo: () => void;
}) {
  const assignee = resolveAssignee(section, item);
  const toggleItem = toToggleItem(item);
  const myTurn = isRunbookItemHumanTurn(assignee, toggleItem);
  const hasHowTo = item.how_to.trim().length > 0;
  return (
    <div
      data-testid="runbook-item-row"
      className={cn(
        "group rounded-lg px-1.5 py-2",
        myTurn && "bg-accent-blue/8",
        item.status === "cancelled" && "opacity-65",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <RunbookItemStatusToggle
          runbook={toToggleRunbook(snapshot.runbook.id, snapshot.runbook.created_session_id)}
          section={toToggleSection(section)}
          item={toggleItem}
          assignee={assignee}
          compact
          controlClassName={cn(myTurn && "text-accent-blue")}
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
            {myTurn ? (
              <Badge variant="info" size="sm" className="h-4 px-1 text-[10px]">내 차례</Badge>
            ) : null}
            {actions ? (
              <RunbookRowActions
                label={`${item.title} 항목 메뉴`}
                actions={actions}
                onPointerDown={stopTileDrag}
              />
            ) : null}
          </div>
          <div className={cn(
            "mt-0.5 flex min-h-5 items-center gap-2 text-muted-foreground",
            textSize === "session" ? "text-xs" : "text-[10px]",
          )}>
            {!myTurn && assignee.kind ? (
              <span className="inline-flex min-w-0 items-center gap-1" title={runbookAssigneeLabel(assignee)}>
                <AssigneeIcon assignee={assignee} />
                <span className="max-w-[112px] truncate">{runbookAssigneeLabel(assignee)}</span>
              </span>
            ) : null}
            {hasHowTo ? (
              <button
                type="button"
                aria-expanded={itemOpen}
                className="ml-auto inline-flex h-5 items-center gap-0.5 rounded px-1 text-accent-blue hover:bg-accent-blue/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60"
                onPointerDown={stopTileDrag}
                onClick={onToggleHowTo}
              >
                <DisclosureActionIcon expanded={itemOpen} className="h-3 w-3" />
                절차
              </button>
            ) : null}
          </div>
          {hasHowTo && itemOpen ? (
            <div
              data-testid="runbook-how-to"
              className={cn(
                "mt-2 border-l-2 border-accent-blue/20 pl-3 leading-relaxed text-foreground/90",
                textSize === "session" ? "text-sm" : "text-xs",
              )}
            >
              <MarkdownContent content={item.how_to} compact />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function itemDefaultOpen(
  section: RunbookSectionRow,
  item: RunbookItemRow,
  defaultOpen: boolean,
): boolean {
  return defaultOpen || isRunbookItemHumanTurn(resolveAssignee(section, item), toToggleItem(item));
}

function resolveAssignee(section: RunbookSectionRow, item: RunbookItemRow): EffectiveAssignee {
  return item.assignee_kind
    ? {
        kind: item.assignee_kind,
        agentId: item.assignee_agent_id,
        sessionId: item.assignee_session_id,
        userId: item.assignee_user_id,
      }
    : {
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

function toToggleRunbook(runbookId: string, createdSessionId: string | null): RunbookStatusToggleRunbook {
  return { id: runbookId, createdSessionId };
}

function toToggleSection(section: RunbookSectionRow): RunbookStatusToggleSection {
  return { createdSessionId: section.created_session_id, updatedSessionId: section.updated_session_id };
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

function stopTileDrag(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}
