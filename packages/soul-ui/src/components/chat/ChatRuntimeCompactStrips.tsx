import { useDashboardStore } from "../../stores/dashboard-store";
import { ClaudeRuntimeNotificationsPanel } from "../ClaudeRuntimeNotificationsPanel";
import { ClaudeRuntimeSchedulesPanel } from "../ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "../ClaudeRuntimeTasksPanel";
import { shouldShowClaudeRuntimePanels } from "../claude-runtime-visibility";

interface ChatRuntimeCompactStripsProps {
  sessionId: string;
}

export function ChatRuntimeCompactStrips({ sessionId }: ChatRuntimeCompactStripsProps) {
  const runtime = useDashboardStore((s) => s.claudeRuntime);
  const backend = useDashboardStore((s) => s.activeSessionSummary?.backend);

  if (!shouldShowClaudeRuntimePanels(backend)) return null;

  return (
    <div className="shrink-0">
      <ClaudeRuntimeTasksPanel sessionId={sessionId} runtime={runtime} tone="calm" />
      <ClaudeRuntimeSchedulesPanel sessionId={sessionId} runtime={runtime} tone="calm" />
      <ClaudeRuntimeNotificationsPanel sessionId={sessionId} tone="calm" />
    </div>
  );
}
