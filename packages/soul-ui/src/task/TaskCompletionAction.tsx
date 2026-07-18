import { useState, type PointerEvent } from "react";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";

import { Button } from "../components/ui/button";
import { DashboardIconCap } from "../components/DashboardIconCap";
import { Badge } from "../components/ui/badge";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { cn } from "../lib/cn";
import {
  type TaskSnapshot,
  type TaskStatus,
  useTaskStore,
} from "../stores/task-store";

interface TaskCompletionActionProps {
  task: {
    id: string;
    title: string;
    status?: TaskStatus | null;
    version?: number | null;
  };
  className?: string;
  buttonClassName?: string;
  onStatusChanged?: (snapshot: TaskSnapshot | null) => Promise<void> | void;
}

function statusErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeTaskStatus(
  status: TaskStatus | null | undefined,
): TaskStatus {
  return status === "completed" ? "completed" : "open";
}

export function isTaskCompleted(status: TaskStatus | null | undefined): boolean {
  return normalizeTaskStatus(status) === "completed";
}

export function createTaskLifecycleIdempotencyKey(
  taskId: string,
  status: TaskStatus,
  expectedVersion: number,
): string {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `task:${taskId}:status:${status}:v${expectedVersion}:${randomId}`;
}

export function TaskCompletionBadge({
  status,
  className,
}: {
  status: TaskStatus | null | undefined;
  className?: string;
}) {
  const normalized = normalizeTaskStatus(status);
  return (
    <Badge
      variant={normalized === "completed" ? "success" : "outline"}
      size="sm"
      className={cn("h-5 px-1.5 text-[10px]", className)}
    >
      {normalized === "completed" ? "완료됨" : "진행 중"}
    </Badge>
  );
}

export function TaskCompletionAction({
  task,
  className,
  buttonClassName,
  onStatusChanged,
}: TaskCompletionActionProps) {
  const loadTask = useTaskStore((s) => s.loadTask);
  const setTaskStatus = useTaskStore((s) => s.setTaskStatus);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentStatus = normalizeTaskStatus(task.status);
  const nextStatus: TaskStatus = currentStatus === "completed" ? "open" : "completed";
  const actionLabel = nextStatus === "completed" ? "업무 완료" : "다시 열기";
  const Icon = nextStatus === "completed" ? CheckCircle2 : RotateCcw;

  const stopPointer = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      const version = typeof task.version === "number"
        ? task.version
        : (await loadTask(task.id, { force: true }))?.task.version;
      if (typeof version !== "number") {
        throw new Error("업무 버전을 확인할 수 없습니다.");
      }
      const snapshot = await setTaskStatus({
        taskId: task.id,
        expectedVersion: version,
        status: nextStatus,
        idempotencyKey: createTaskLifecycleIdempotencyKey(
          task.id,
          nextStatus,
          version,
        ),
      });
      await onStatusChanged?.(snapshot);
      setOpen(false);
    } catch (caught) {
      setError(statusErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <TaskCompletionBadge status={currentStatus} />
      <DashboardIconCap
        label={actionLabel}
        className={buttonClassName}
        disabled={pending}
        onPointerDown={stopPointer}
        onClick={(event) => {
          event.stopPropagation();
          setError(null);
          setOpen(true);
        }}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      </DashboardIconCap>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nextStatus === "completed" ? "업무를 완료할까요?" : "업무를 다시 열까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nextStatus === "completed"
                ? `${task.title}의 남은 진행을 완료 상태로 표시합니다.`
                : `${task.title}을 다시 진행 중 상태로 되돌립니다.`}
            </AlertDialogDescription>
            {error ? (
              <p data-testid="task-status-error" className="text-sm text-accent-red">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={pending}
              onPointerDown={stopPointer}
              onClick={() => setOpen(false)}
            >
              취소
            </Button>
            <Button
              variant={nextStatus === "completed" ? "success" : "default"}
              disabled={pending}
              onPointerDown={stopPointer}
              onClick={() => void handleConfirm()}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {actionLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
