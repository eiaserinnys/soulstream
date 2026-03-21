/**
 * SessionInfoView - 세션 메타데이터 실시간 표시
 *
 * 활성 세션의 메타데이터(커밋, 브랜치, 파일 변경 등)를 표시한다.
 * RightPanel의 Session Info 탭에서 사용된다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { SessionMetadata } from "./detail/SessionMetadata";
import { ScrollArea } from "./ui/scroll-area";

export function SessionInfoView() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);
  const metadata = activeSessionKey
    ? sessions.find((s) => s.agentSessionId === activeSessionKey)?.metadata
    : undefined;

  if (!activeSessionKey) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-muted-foreground text-[13px]">Select a session</div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <SessionMetadata metadata={metadata ?? []} />
    </ScrollArea>
  );
}
