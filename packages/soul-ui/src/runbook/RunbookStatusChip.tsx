import {
  CheckCircle2,
  Circle,
  Clock3,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/cn";
import type { RunbookItemStatus } from "../stores/runbook-store";

const statusConfig: Record<RunbookItemStatus, {
  label: string;
  icon: LucideIcon;
  className: string;
}> = {
  pending: {
    label: "대기",
    icon: Circle,
    className: "border-glass-border glass text-muted-foreground",
  },
  in_progress: {
    label: "진행",
    icon: Clock3,
    className: "border-accent-blue/35 glass text-accent-blue",
  },
  completed: {
    label: "완료",
    icon: CheckCircle2,
    className: "border-success/35 glass text-success",
  },
  cancelled: {
    label: "취소",
    icon: XCircle,
    className: "border-glass-border glass text-muted-foreground",
  },
};

export function RunbookStatusChip({
  status,
  className,
}: {
  status: RunbookItemStatus;
  className?: string;
}) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[10px] font-semibold",
        config.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}
