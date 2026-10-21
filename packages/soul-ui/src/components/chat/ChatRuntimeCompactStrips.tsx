import { useChatStore } from "../../stores/chat-store-scope";
import { ClaudeRuntimeNotificationsPanel } from "../ClaudeRuntimeNotificationsPanel";
import { ClaudeRuntimeSchedulesPanel } from "../ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "../ClaudeRuntimeTasksPanel";
import { shouldShowClaudeRuntimePanels } from "../claude-runtime-visibility";

interface ChatRuntimeCompactStripsProps {
  sessionId: string;
  variant?: "default" | "caption";
}

export function ChatRuntimeCompactStrips({ sessionId, variant = "default" }: ChatRuntimeCompactStripsProps) {
  const runtime = useChatStore((s) => s.claudeRuntime);
  const backend = useChatStore((s) => s.activeSessionSummary?.backend);

  if (!shouldShowClaudeRuntimePanels(backend)) return null;

  return (
    <div className="shrink-0">
      <ClaudeRuntimeTasksPanel sessionId={sessionId} runtime={runtime} tone="calm" variant={variant} />
      <ClaudeRuntimeSchedulesPanel sessionId={sessionId} runtime={runtime} tone="calm" variant={variant} />
      <ClaudeRuntimeNotificationsPanel sessionId={sessionId} tone="calm" variant={variant} />
    </div>
  );
}
