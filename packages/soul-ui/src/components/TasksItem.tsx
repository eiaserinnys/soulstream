/**
 * TasksItem — 폴더 트리 상단의 특수 "작업" 항목
 *
 * 클릭 시 center panel을 Task Tree view로 전환한다.
 */

import { ListChecks } from "lucide-react";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";

export function TasksItem() {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setViewMode = useDashboardStore((s) => s.setViewMode);

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50",
        viewMode === "tasks" && "bg-accent text-accent-foreground",
      )}
      onClick={() => setViewMode("tasks")}
    >
      <div className="flex items-center gap-1.5">
        <ListChecks className="h-3.5 w-3.5" />
        <span>작업</span>
      </div>
    </div>
  );
}
