import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type PointerEvent,
} from "react";

import { cn } from "../lib/cn";
import {
  type ChecklistAssigneeKind,
  type ChecklistItemStatus,
  type FolderSnapshot,
  useFolderChecklistStore,
} from "../stores/folder-checklist-store";
import { FolderStatusChip } from "./FolderStatusChip";

export interface ChecklistStatusToggleAssignee {
  kind: ChecklistAssigneeKind | null;
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
}

export interface ChecklistStatusToggleTask {
  id: string;
  createdSessionId: string | null;
}

export interface ChecklistStatusToggleSection {
  createdSessionId: string | null;
  updatedSessionId: string | null;
}

export interface ChecklistStatusToggleItem {
  id: string;
  status: ChecklistItemStatus;
  archived: boolean;
  version: number;
  createdSessionId: string | null;
  updatedSessionId: string | null;
}

type WritableStatus = Extract<ChecklistItemStatus, "pending" | "completed" | "cancelled">;

function statusErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isChecklistItemTerminal(status: ChecklistItemStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function isChecklistItemReview(status: ChecklistItemStatus): boolean {
  return status === "review";
}

export function isChecklistItemHumanTurn(
  assignee: ChecklistStatusToggleAssignee,
  item: Pick<ChecklistStatusToggleItem, "archived" | "status">,
): boolean {
  return (assignee.kind === "human" || isChecklistItemReview(item.status)) &&
    !item.archived &&
    !isChecklistItemTerminal(item.status);
}

export function isChecklistItemHumanWritable(
  assignee: ChecklistStatusToggleAssignee,
  item: Pick<ChecklistStatusToggleItem, "archived" | "status">,
): boolean {
  return (assignee.kind === "human" || isChecklistItemReview(item.status)) &&
    !item.archived &&
    item.status !== "cancelled";
}

export function resolveChecklistItemActorSessionId(
  task: ChecklistStatusToggleTask,
  section: ChecklistStatusToggleSection,
  item: ChecklistStatusToggleItem,
  assignee: ChecklistStatusToggleAssignee,
): string | null {
  return assignee.sessionId ||
    item.updatedSessionId ||
    item.createdSessionId ||
    section.updatedSessionId ||
    section.createdSessionId ||
    task.createdSessionId ||
    null;
}

export function checklistItemStatusDisabledReason(
  task: ChecklistStatusToggleTask,
  section: ChecklistStatusToggleSection,
  item: ChecklistStatusToggleItem,
  assignee: ChecklistStatusToggleAssignee,
  pending: boolean,
): string | null {
  if (pending) return "상태 변경 중";
  if (item.archived) return "보관된 항목";
  if (item.status === "cancelled") return "취소된 항목";
  if (assignee.kind !== "human" && !isChecklistItemReview(item.status)) {
    return "사람 담당 항목만 직접 변경할 수 있음";
  }
  return null;
}

export function createChecklistStatusIdempotencyKey(
  folderId: string,
  itemId: string,
  status: WritableStatus,
  expectedVersion: number,
): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `task:${folderId}:item:${itemId}:status:${status}:v${expectedVersion}:${randomId}`;
}

export function checklistAssigneeLabel(assignee: ChecklistStatusToggleAssignee): string {
  if (assignee.kind === "human") return assignee.userId || "사람";
  if (assignee.kind === "agent") return assignee.agentId || "에이전트";
  if (assignee.kind === "session") return assignee.sessionId || "세션";
  return "미지정";
}

interface ChecklistItemStatusToggleProps {
  task: ChecklistStatusToggleTask;
  section: ChecklistStatusToggleSection;
  item: ChecklistStatusToggleItem;
  assignee: ChecklistStatusToggleAssignee;
  className?: string;
  controlClassName?: string;
  chipClassName?: string;
  captionClassName?: string;
  showCaption?: boolean;
  compact?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onStatusChanged?: (snapshot: FolderSnapshot | null) => Promise<void> | void;
}

export function ChecklistItemStatusToggle({
  task,
  section,
  item,
  assignee,
  className,
  controlClassName,
  chipClassName,
  captionClassName,
  showCaption = true,
  compact = false,
  onPointerDown,
  onStatusChanged,
}: ChecklistItemStatusToggleProps) {
  const setItemStatus = useFolderChecklistStore((s) => s.setItemStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimisticStatus, setOptimisticStatus] = useState<ChecklistItemStatus | null>(null);
  const captionId = useId();
  const displayStatus = optimisticStatus ?? item.status;
  const displayItem = { ...item, status: displayStatus };
  const disabledReason = checklistItemStatusDisabledReason(
    task,
    section,
    displayItem,
    assignee,
    pending,
  );
  const writable = isChecklistItemHumanWritable(assignee, displayItem) && !disabledReason;
  const checked = displayStatus === "completed";
  // 비활성 사유는 상시 캡션이 아니라 title 툴팁으로만 노출한다 (260718 디렉터 지시).
  const helpId = showCaption && error ? captionId : undefined;

  useEffect(() => {
    if (optimisticStatus && item.status === optimisticStatus) {
      setOptimisticStatus(null);
    }
  }, [item.status, optimisticStatus]);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    const nextStatus: WritableStatus = event.currentTarget.checked ? "completed" : "pending";
    setPending(true);
    setError(null);
    setOptimisticStatus(nextStatus);
    try {
      const snapshot = await setItemStatus({
        folderId: task.id,
        itemId: item.id,
        expectedVersion: item.version,
        status: nextStatus,
        idempotencyKey: createChecklistStatusIdempotencyKey(
          task.id,
          item.id,
          nextStatus,
          item.version,
        ),
      });
      await onStatusChanged?.(snapshot);
    } catch (caught) {
      setOptimisticStatus(null);
      setError(statusErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn("min-w-0", className)}>
      <label
        data-testid="task-status-toggle"
        aria-disabled={!writable}
        title={disabledReason ?? (checked ? "완료 해제" : "완료 표시")}
        className={cn(
          compact
            ? "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors"
            : "flex min-h-10 shrink-0 cursor-pointer items-center gap-2 rounded-[10px] border border-glass-border glass px-2 py-1 text-[11px] font-semibold text-muted-foreground glass-shadow-xs transition-colors",
          compact ? "hover:bg-muted/45 hover:text-accent-blue" : "hover:border-accent-blue/45 hover:text-accent-blue",
          checked && "text-success",
          !writable && cn(
            "cursor-not-allowed opacity-60 hover:text-muted-foreground",
            compact ? "hover:bg-transparent" : "hover:border-glass-border",
          ),
          controlClassName,
        )}
        onPointerDown={onPointerDown}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!writable}
          title={disabledReason ?? (checked ? "완료 해제" : "완료 표시")}
          aria-describedby={helpId}
          className={cn(
            "shrink-0 accent-accent-blue",
            compact ? "h-4 w-4" : "h-5 w-5",
          )}
          onChange={(event) => void handleChange(event)}
        />
        {compact ? null : (
          <FolderStatusChip
            status={displayStatus}
            className={cn("pointer-events-none h-6 px-2 text-[11px]", chipClassName)}
          />
        )}
      </label>
      {showCaption && error ? (
        <div
          id={captionId}
          data-testid="task-status-error"
          className={cn("mt-1 text-[10px] leading-4 text-accent-red", captionClassName)}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
