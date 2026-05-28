/**
 * SessionInfoView - 세션 메타데이터 실시간 표시
 *
 * 활성 세션의 메타데이터(커밋, 브랜치, 파일 변경 등)를 표시한다.
 * RightPanel의 Session Info 탭에서 사용된다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { ClaudeRuntimeTasksPanel } from "./ClaudeRuntimeTasksPanel";
import { SessionMetadata } from "./detail/SessionMetadata";
import { ScrollArea } from "./ui/scroll-area";

export function SessionInfoView() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const metadata = useDashboardStore((s) => s.activeSessionSummary?.metadata);
  const callerSessionId = useDashboardStore((s) => s.activeSessionSummary?.callerSessionId);
  const claudeRuntime = useDashboardStore((s) => s.claudeRuntime);

  if (!activeSessionKey) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-sm">Select a session</div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <SessionMetadata metadata={metadata ?? []} callerSessionId={callerSessionId} />
      <ClaudeRuntimeTasksPanel sessionId={activeSessionKey} runtime={claudeRuntime} />
    </ScrollArea>
  );
}
