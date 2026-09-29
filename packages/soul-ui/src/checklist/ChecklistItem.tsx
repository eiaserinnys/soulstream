import type { PointerEvent } from "react";
import { Bot, Circle, MessageSquare, UserRound } from "lucide-react";

import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { MarkdownContent } from "../components/MarkdownContent";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import type {
  ChecklistAssigneeKind,
  ChecklistItemRow,
  ChecklistSectionRow,
  FolderSnapshot,
} from "../stores/folder-checklist-store";
import {
  FolderRowActionButton,
  FolderRowActions,
  type RowAction,
} from "./ChecklistControls";
import {
  ChecklistItemStatusToggle,
  isChecklistItemHumanTurn,
  checklistAssigneeLabel,
  type ChecklistStatusToggleItem,
  type ChecklistStatusToggleTask,
  type ChecklistStatusToggleSection,
} from "./ChecklistItemStatusToggle";

interface EffectiveAssignee {
  kind: ChecklistAssigneeKind | null;
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
}

export function ChecklistItemRowView({
  snapshot,
  section,
  item,
  itemOpen,
  textSize,
  actions,
  onToggleHowTo,
}: {
  snapshot: FolderSnapshot;
  section: ChecklistSectionRow;
  item: ChecklistItemRow;
  itemOpen: boolean;
  textSize: "compact" | "session";
  actions: readonly RowAction[] | null;
  onToggleHowTo: () => void;
}) {
  const assignee = resolveAssignee(section, item);
  const toggleItem = toToggleItem(item);
  const myTurn = isChecklistItemHumanTurn(assignee, toggleItem);
  const hasHowTo = item.howTo.trim().length > 0;
  const hasAssignee = assignee.kind !== null;
  const hasDetails = hasHowTo || hasAssignee;
  return (
    <div
      data-testid="task-item-row"
      className={cn(
        "group rounded-lg px-1.5 py-2",
        myTurn && "bg-accent-blue/8",
        item.status === "cancelled" && "opacity-65",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <ChecklistItemStatusToggle
          task={toToggleTask(snapshot.folder.id, snapshot.folder.createdSessionId)}
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
              data-testid="task-item-title"
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
                data-testid="task-item-actions"
                className="flex shrink-0 items-center gap-1"
              >
                {actions ? (
                  <FolderRowActions
                    label={`${item.title} 항목 메뉴`}
                    actions={actions}
                    onPointerDown={stopTileDrag}
                  />
                ) : null}
                {hasDetails ? (
                  <FolderRowActionButton
                    data-testid="task-item-details-toggle"
                    aria-label={`${item.title} 상세 ${itemOpen ? "접기" : "펼치기"}`}
                    aria-expanded={itemOpen}
                    onPointerDown={stopTileDrag}
                    onClick={onToggleHowTo}
                  >
                    <DisclosureActionIcon expanded={itemOpen} className="h-4 w-4" />
                  </FolderRowActionButton>
                ) : null}
              </div>
            ) : null}
          </div>
          {hasDetails && itemOpen ? (
            <div
              data-testid="task-how-to"
              className={cn(
                "mt-2 space-y-2 border-l-2 border-accent-blue/20 pl-3 leading-relaxed text-foreground/90",
                textSize === "session" ? "text-sm" : "text-xs",
              )}
            >
              {hasAssignee ? (
                <div
                  data-testid="task-item-assignee"
                  className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
                  title={checklistAssigneeLabel(assignee)}
                >
                  <AssigneeIcon assignee={assignee} />
                  <span className="min-w-0 truncate">{checklistAssigneeLabel(assignee)}</span>
                  {myTurn ? (
                    <Badge variant="info" size="sm" className="h-4 px-1 text-[10px]">내 차례</Badge>
                  ) : null}
                </div>
              ) : null}
              {hasHowTo ? <MarkdownContent content={item.howTo} compact /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function resolveAssignee(section: ChecklistSectionRow, item: ChecklistItemRow): EffectiveAssignee {
  return item.assigneeKind
    ? {
        kind: item.assigneeKind,
        agentId: item.assigneeAgentId,
        sessionId: item.assigneeSessionId,
        userId: item.assigneeUserId,
      }
    : {
        kind: section.assigneeKind,
        agentId: section.assigneeAgentId,
        sessionId: section.assigneeSessionId,
        userId: section.assigneeUserId,
      };
}

function AssigneeIcon({ assignee }: { assignee: EffectiveAssignee }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (assignee.kind === "human") return <UserRound className={className} aria-label="human" />;
  if (assignee.kind === "agent") return <Bot className={className} aria-label="agent" />;
  if (assignee.kind === "session") return <MessageSquare className={className} aria-label="session" />;
  return <Circle className={className} aria-label="unassigned" />;
}

function toToggleTask(folderId: string, createdSessionId: string | null): ChecklistStatusToggleTask {
  return { id: folderId, createdSessionId };
}

function toToggleSection(section: ChecklistSectionRow): ChecklistStatusToggleSection {
  return { createdSessionId: section.createdSessionId, updatedSessionId: section.updatedSessionId };
}

function toToggleItem(item: ChecklistItemRow): ChecklistStatusToggleItem {
  return {
    id: item.id,
    status: item.status,
    archived: item.archived,
    version: item.version,
    createdSessionId: item.createdSessionId,
    updatedSessionId: item.updatedSessionId,
  };
}

function stopTileDrag(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}
