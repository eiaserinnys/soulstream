import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";

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

  return (
    <Button
      variant="ghost"
      className="v3-task-detail-today"
      aria-pressed={inToday}
      disabled={pending}
      onClick={() => { void toggle().catch(() => undefined); }}
    >
      <span aria-hidden="true">{inToday ? "✓" : "＋"}</span> {todayPlannerMenuLabel(inToday)}
    </Button>
  );
}
