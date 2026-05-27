import { createElement } from "react";
import type React from "react";
import {
  CheckCircle2,
  Circle,
  CircleSlash,
  Copy,
  Edit3,
  MessageSquarePlus,
  OctagonAlert,
  PauseCircle,
  Pin,
  PinOff,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import type { SessionSummary, TaskItem, TaskStatus } from "../shared";
import { cn } from "../lib/cn";
import type { TaskTreeRow } from "./task-tree-layout";

export const STATUS_META: Record<
  TaskStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  open: { label: "Open", icon: Circle, className: "text-muted-foreground" },
  in_progress: { label: "In Progress", icon: Play, className: "text-info" },
  agent_done: { label: "Agent Done", icon: CheckCircle2, className: "text-primary" },
  verified_done: { label: "완료", icon: ShieldCheck, className: "text-muted-foreground" },
  reopened: { label: "Reopened", icon: RotateCcw, className: "text-accent-amber" },
  blocked: { label: "Blocked", icon: OctagonAlert, className: "text-accent-red" },
  cancelled: { label: "Cancelled", icon: CircleSlash, className: "text-muted-foreground" },
};

export const STATUS_OPTIONS: TaskStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "agent_done",
  "verified_done",
  "reopened",
  "cancelled",
];

export function TaskTreeLines({ row }: { row: TaskTreeRow }) {
  if (row.depth === 0) return null;
  const slots = Array.from({ length: row.depth });
  return (
    <div className="-mr-2 flex self-stretch shrink-0" aria-hidden>
      {slots.map((_, index) => {
        const isBranchSlot = index === row.depth - 1;
        const ancestorIsLast = row.ancestorLast[index] ?? true;
        return (
          <span key={index} className="relative w-8 shrink-0">
            {!isBranchSlot && !ancestorIsLast && (
              <span className="absolute left-1/2 top-0 bottom-0 border-l border-border/70" />
            )}
            {isBranchSlot && (
              <>
                <span className="absolute left-1/2 top-0 h-1/2 border-l border-border/70" />
                {!row.isLast && (
                  <span className="absolute left-1/2 top-1/2 bottom-0 border-l border-border/70" />
                )}
                <span className="absolute left-1/2 right-[-1rem] top-1/2 border-t border-border/70" />
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function TaskStatusLineOverlay({ row }: { row: TaskTreeRow }) {
  if (!row.hasChildren) return null;
  return (
    <span className="absolute left-1/2 top-1/2 bottom-0 border-l border-border/70" aria-hidden />
  );
}

export function TaskContextMenu({
  x,
  y,
  task,
  pending,
  onClose,
  onCopy,
  onStartChildSession,
  onEdit,
  onStatus,
  onPin,
  onHold,
}: {
  x: number;
  y: number;
  task: TaskItem;
  pending: boolean;
  onClose: () => void;
  onCopy: () => void;
  onStartChildSession?: () => void;
  onEdit: () => void;
  onStatus: (status: TaskStatus) => void;
  onPin: (pinned: boolean) => void;
  onHold: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-30 cursor-default"
        aria-label="Close task menu"
        onClick={onClose}
      />
      <div
        className="fixed z-40 w-56 rounded-md border border-border bg-popover p-1 shadow-lg"
        style={{ left: x, top: y }}
      >
        <MenuButton icon={<Copy className="h-4 w-4" />} onClick={onCopy}>
          Task ID 복사
        </MenuButton>
        {onStartChildSession && (
          <MenuButton icon={<MessageSquarePlus className="h-4 w-4" />} onClick={onStartChildSession}>
            하위 대화 시작
          </MenuButton>
        )}
        <MenuButton icon={<Edit3 className="h-4 w-4" />} onClick={onEdit}>
          태스크 편집
        </MenuButton>
        <div className="my-1 border-t border-border" />
        {STATUS_OPTIONS.filter((status) => status !== task.status).map((status) => (
          <MenuButton
            key={status}
            icon={createElement(STATUS_META[status].icon, {
              className: cn("h-4 w-4", STATUS_META[status].className),
            })}
            disabled={pending}
            onClick={() => onStatus(status)}
          >
            {STATUS_META[status].label}로 변경
          </MenuButton>
        ))}
        <div className="my-1 border-t border-border" />
        <MenuButton
          icon={task.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          disabled={pending}
          onClick={() => onPin(!task.pinned)}
        >
          {task.pinned ? "고정 해제" : "상단에 고정"}
        </MenuButton>
        <MenuButton
          icon={<PauseCircle className="h-4 w-4" />}
          disabled={pending}
          onClick={onHold}
        >
          보류하기
        </MenuButton>
      </div>
    </>
  );
}

function MenuButton({
  icon,
  children,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function LinkedSessionRuntimeIndicator({ status }: { status?: SessionSummary["status"] }) {
  if (status !== "running") return null;
  return (
    <span
      className="relative h-3 w-3 shrink-0"
      title="Linked session running"
      aria-label="Linked session running"
    >
      <span className="absolute inset-0 rounded-full bg-success/40 animate-ping" />
      <span className="absolute inset-1 rounded-full bg-success" />
    </span>
  );
}

export function AgentAvatar({ portraitUrl }: { portraitUrl: string | null }) {
  if (portraitUrl) {
    return (
      <img
        src={portraitUrl}
        alt=""
        className="h-8 w-8 rounded-lg object-cover shrink-0"
      />
    );
  }
  return (
    <span className="h-8 w-8 rounded-lg border border-border bg-muted flex items-center justify-center text-xs text-muted-foreground shrink-0">
      A
    </span>
  );
}
