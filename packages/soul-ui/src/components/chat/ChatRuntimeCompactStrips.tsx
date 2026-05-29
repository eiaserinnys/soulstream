import { useDashboardStore } from "../../stores/dashboard-store";
import { ClaudeRuntimeNotificationsPanel } from "../ClaudeRuntimeNotificationsPanel";
import { ClaudeRuntimeSchedulesPanel } from "../ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "../ClaudeRuntimeTasksPanel";

interface ChatRuntimeCompactStripsProps {
  sessionId: string;
}

export function ChatRuntimeCompactStrips({ sessionId }: ChatRuntimeCompactStripsProps) {
  const runtime = useDashboardStore((s) => s.claudeRuntime);

  return (
    <div className="shrink-0">
      <ClaudeRuntimeTasksPanel sessionId={sessionId} runtime={runtime} />
      <ClaudeRuntimeSchedulesPanel sessionId={sessionId} runtime={runtime} />
      <ClaudeRuntimeNotificationsPanel sessionId={sessionId} />
    </div>
  );
}
