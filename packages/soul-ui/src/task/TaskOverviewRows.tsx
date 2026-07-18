import { type KeyboardEvent } from "react";
import { BookOpenCheck, ExternalLink, Info } from "lucide-react";

import { Badge } from "../components/ui/badge";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "../components/ui/preview-card";
import { MarkdownContent } from "../components/MarkdownContent";
import { cn } from "../lib/cn";
import {
  type TaskOverviewGroup,
  type TaskOverviewItem,
} from "../stores/task-store";
import {
  TaskItemStatusToggle,
  isTaskItemReview,
  isTaskItemTerminal,
  taskAssigneeLabel,
  type TaskStatusToggleAssignee,
  type TaskStatusToggleItem,
  type TaskStatusToggleTask,
  type TaskStatusToggleSection,
} from "./TaskItemStatusToggle";
import { TaskCompletionAction } from "./TaskCompletionAction";

export interface TaskAttentionCounts {
  todo: number;
  review: number;
  total: number;
}

function toOverviewAssignee(item: TaskOverviewItem): TaskStatusToggleAssignee {
  return {
    kind: item.effective_assignee_kind,
    agentId: item.effective_assignee_agent_id,
    sessionId: item.effective_assignee_session_id,
    userId: item.effective_assignee_user_id,
  };
}

function toOverviewTask(item: TaskOverviewItem): TaskStatusToggleTask {
  return {
    id: item.task_id,
    createdSessionId: item.task_created_session_id,
  };
}

function toOverviewSection(item: TaskOverviewItem): TaskStatusToggleSection {
  return {
    createdSessionId: item.section_created_session_id,
    updatedSessionId: item.section_updated_session_id,
  };
}

function toOverviewItem(item: TaskOverviewItem): TaskStatusToggleItem {
  return {
    id: item.item_id,
    status: item.status,
    archived: false,
    version: item.item_version,
    createdSessionId: item.item_created_session_id,
    updatedSessionId: item.item_updated_session_id,
  };
}

function assigneeLabel(item: TaskOverviewItem): string {
  return taskAssigneeLabel(toOverviewAssignee(item));
}

function isDone(item: TaskOverviewItem): boolean {
  return isTaskItemTerminal(item.status);
}

export function isTodoItem(item: TaskOverviewItem): boolean {
  return item.effective_assignee_kind === "human" &&
    (item.status === "pending" || item.status === "in_progress");
}

export function countAttentionItems(items: TaskOverviewItem[]): TaskAttentionCounts {
  const todo = items.filter(isTodoItem).length;
  const review = items.filter((item) => isTaskItemReview(item.status)).length;
  return { todo, review, total: todo + review };
}

export function taskAttentionCounts(
  group: TaskOverviewGroup,
  myTurnItems: TaskOverviewItem[],
): TaskAttentionCounts {
  return countAttentionItems(
    myTurnItems.filter((item) => item.task_id === group.task_id),
  );
}

export function progressText(group: TaskOverviewGroup): string {
  return `${group.completed_count}/${group.total_count}`;
}

function OpenItemBoardButton({
  item,
  onOpenBoard,
}: {
  item: TaskOverviewItem;
  onOpenBoard: (item: TaskOverviewItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid="task-overview-open-board"
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

function OpenTaskBoardButton({
  group,
  onOpenTaskBoard,
}: {
  group: TaskOverviewGroup;
  onOpenTaskBoard: (group: TaskOverviewGroup) => void;
}) {
  return (
    <button
      type="button"
      data-testid="task-overview-row-open-board"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-blue/10 hover:text-accent-blue focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/55"
      title="업무 보드 열기"
      aria-label={`${group.task_title} 업무 보드 열기`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenTaskBoard(group);
      }}
    >
      <ExternalLink className="h-4 w-4" />
    </button>
  );
}

function TaskHowToPreview({
  item,
  className,
}: {
  item: TaskOverviewItem;
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
        data-testid="task-overview-item-how-to-trigger"
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
        data-testid="task-overview-item-how-to"
        align="start"
        sideOffset={8}
        className="max-h-[min(28rem,calc(100vh-6rem))] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-[12px] p-3 text-xs leading-relaxed"
      >
        <MarkdownContent content={howTo} compact />
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function TaskAttentionMark({ counts }: { counts: TaskAttentionCounts }) {
  if (counts.total <= 0) {
    return (
      <span
        data-testid="task-overview-task-attention-placeholder"
        className="h-5 min-w-5 shrink-0"
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      data-testid="task-overview-task-attention"
      aria-label={`확인할 항목 ${counts.total}개`}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-accent-red/35 bg-accent-red/10 px-1.5 text-[10px] font-semibold text-accent-red"
      title={`할 일 ${counts.todo}개 · 확인 대기 ${counts.review}개`}
    >
      {counts.total}
    </span>
  );
}

export function GroupItemRow({
  item,
  onOpenBoard,
  onStatusChanged,
}: {
  item: TaskOverviewItem;
  onOpenBoard: (item: TaskOverviewItem) => void;
  onStatusChanged: () => Promise<void>;
}) {
  const assignee = toOverviewAssignee(item);
  return (
    <div
      data-testid="task-overview-group-item"
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-[12px] border border-glass-border glass px-2.5 py-2 text-left glass-shadow-xs transition-colors hover:border-accent-blue/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/50",
        isDone(item) && "opacity-70",
      )}
    >
      <TaskItemStatusToggle
        task={toOverviewTask(item)}
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
          <TaskHowToPreview item={item} className="h-5 w-5" />
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
      <OpenItemBoardButton item={item} onOpenBoard={onOpenBoard} />
    </div>
  );
}

export function TaskListRow({
  group,
  attention,
  selected,
  onSelect,
  onOpenTaskBoard,
  onStatusChanged,
}: {
  group: TaskOverviewGroup;
  attention: TaskAttentionCounts;
  selected: boolean;
  onSelect: () => void;
  onOpenTaskBoard: (group: TaskOverviewGroup) => void;
  onStatusChanged: () => Promise<void>;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      data-testid="task-overview-task-row"
      data-task-id={group.task_id}
      className={cn(
        "grid min-h-13 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[12px] border glass px-3 py-2 text-left glass-shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/55",
        selected
          ? "border-accent-blue/55 ring-1 ring-accent-blue/35"
          : "border-glass-border hover:border-accent-blue/35",
      )}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
    >
      <TaskAttentionMark counts={attention} />
      <div className="flex min-w-0 items-center gap-2">
        <BookOpenCheck className="h-4 w-4 shrink-0 text-accent-blue" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
          {group.task_title}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge variant="outline" size="sm" className="h-5 px-1.5 text-[10px]">
          {progressText(group)}
        </Badge>
        <TaskCompletionAction
          task={{
            id: group.task_id,
            title: group.task_title,
            status: group.task_status,
            version: group.task_version ?? null,
          }}
          buttonClassName="px-1.5 text-[10px]"
          onStatusChanged={onStatusChanged}
        />
        <OpenTaskBoardButton
          group={group}
          onOpenTaskBoard={onOpenTaskBoard}
        />
      </div>
    </div>
  );
}

export function TaskItemsPane({
  group,
  onOpenBoard,
  onStatusChanged,
}: {
  group: TaskOverviewGroup | null;
  onOpenBoard: (item: TaskOverviewItem) => void;
  onStatusChanged: () => Promise<void>;
}) {
  if (!group) {
    return (
      <div
        data-testid="task-overview-selected-empty"
        className="flex h-full min-h-0 items-center justify-center rounded-[14px] border border-dashed border-[var(--lg-line)] px-3 text-center text-sm text-muted-foreground"
      >
        업무를 선택하면 항목이 표시됩니다
      </div>
    );
  }

  return (
    <section
      data-testid="task-overview-selected-items"
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BookOpenCheck className="h-4 w-4 shrink-0 text-accent-blue" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-5">{group.task_title}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            항목 {group.items.length}개 · 진척 {progressText(group)}
          </p>
        </div>
      </div>
      <div
        data-testid="task-overview-selected-items-scroll"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
      >
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
    </section>
  );
}
