import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw } from "lucide-react";

import type { TaskItem } from "../shared";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

interface TaskTreeDetailPanelProps {
  task: TaskItem | null;
  saving?: boolean;
  onSave: (task: TaskItem, draft: TaskEditDraft) => void;
}

export interface TaskEditDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
}

export function TaskTreeDetailPanel({
  task,
  saving = false,
  onSave,
}: TaskTreeDetailPanelProps) {
  const [draft, setDraft] = useState<TaskEditDraft>(() => draftFromTask(task));

  useEffect(() => {
    setDraft(draftFromTask(task));
  }, [task?.id, task?.title, task?.description, task?.acceptanceCriteria]);

  const dirty = useMemo(() => {
    if (!task) return false;
    return (
      draft.title !== task.title ||
      draft.description !== task.description ||
      draft.acceptanceCriteria !== task.acceptanceCriteria
    );
  }, [draft, task]);

  if (!task) {
    return (
      <section className="h-full min-h-0 border-t border-border bg-muted/20 px-4 py-3">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          태스크를 선택하세요
        </div>
      </section>
    );
  }

  const canSave = dirty && draft.title.trim().length > 0 && !saving;

  return (
    <section className="h-full min-h-0 overflow-auto border-t border-border bg-background px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            태스크 상세
          </div>
          <div className="truncate text-xs text-muted-foreground/80">
            {task.status} · v{task.version}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="변경 취소"
            disabled={!dirty || saving}
            onClick={() => setDraft(draftFromTask(task))}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!canSave}
            onClick={() => onSave(task, normalizeDraft(draft))}
          >
            <Check className="mr-1 h-4 w-4" />
            저장
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">제목</span>
          <Input
            value={draft.title}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, title: value }));
            }}
            className={cn(!draft.title.trim() && "border-accent-red")}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">설명</span>
          <Textarea
            value={draft.description}
            placeholder="설명 추가"
            rows={4}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                description: value,
              }));
            }}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">완료 기준</span>
          <Textarea
            value={draft.acceptanceCriteria}
            placeholder="완료 기준 추가"
            rows={4}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                acceptanceCriteria: value,
              }));
            }}
          />
        </label>
      </div>
    </section>
  );
}

function draftFromTask(task: TaskItem | null): TaskEditDraft {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    acceptanceCriteria: task?.acceptanceCriteria ?? "",
  };
}

function normalizeDraft(draft: TaskEditDraft): TaskEditDraft {
  return {
    title: draft.title.trim(),
    description: draft.description,
    acceptanceCriteria: draft.acceptanceCriteria,
  };
}
