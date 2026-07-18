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
import {
  RunbookRowActionButton,
  RunbookRowActions,
  type RowAction,
} from "./RunbookChecklistControls";
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
  const hasAssignee = assignee.kind !== null;
  const hasDetails = hasHowTo || hasAssignee;
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
            {actions || hasDetails ? (
              <div
                data-testid="runbook-item-actions"
                className="flex shrink-0 items-center gap-1"
              >
                {actions ? (
                  <RunbookRowActions
                    label={`${item.title} 항목 메뉴`}
                    actions={actions}
                    onPointerDown={stopTileDrag}
                  />
                ) : null}
                {hasDetails ? (
                  <RunbookRowActionButton
                    data-testid="runbook-item-details-toggle"
                    aria-label={`${item.title} 상세 ${itemOpen ? "접기" : "펼치기"}`}
                    aria-expanded={itemOpen}
                    onPointerDown={stopTileDrag}
                    onClick={onToggleHowTo}
                  >
                    <DisclosureActionIcon expanded={itemOpen} className="h-4 w-4" />
                  </RunbookRowActionButton>
                ) : null}
              </div>
            ) : null}
          </div>
          {hasDetails && itemOpen ? (
            <div
              data-testid="runbook-how-to"
              className={cn(
                "mt-2 space-y-2 border-l-2 border-accent-blue/20 pl-3 leading-relaxed text-foreground/90",
                textSize === "session" ? "text-sm" : "text-xs",
              )}
            >
              {hasAssignee ? (
                <div
                  data-testid="runbook-item-assignee"
                  className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
                  title={runbookAssigneeLabel(assignee)}
                >
                  <AssigneeIcon assignee={assignee} />
                  <span className="min-w-0 truncate">{runbookAssigneeLabel(assignee)}</span>
                  {myTurn ? (
                    <Badge variant="info" size="sm" className="h-4 px-1 text-[10px]">내 차례</Badge>
                  ) : null}
                </div>
              ) : null}
              {hasHowTo ? <MarkdownContent content={item.how_to} compact /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
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
