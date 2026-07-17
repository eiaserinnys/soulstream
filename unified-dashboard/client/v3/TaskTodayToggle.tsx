import { useState } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { CalendarMinus2, CalendarPlus2 } from "lucide-react";

import { todayPlannerMenuLabel } from "./today-task-state";

export function TaskTodayToggle({
  inToday,
  onToggle,
}: {
  inToday: boolean;
  onToggle(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onToggle();
    } finally {
      setPending(false);
    }
  };

  const label = todayPlannerMenuLabel(inToday);
  const Icon = inToday ? CalendarMinus2 : CalendarPlus2;

  return (
    <DashboardIconCap
      label={label}
      className="v3-task-detail-today"
      aria-pressed={inToday}
      disabled={pending}
      onClick={() => { void toggle().catch(() => undefined); }}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </DashboardIconCap>
  );
}
