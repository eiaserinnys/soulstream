/**
 * SessionsTopBar - 세션 목록 상단 바
 *
 * 'Sessions' 제목과 'New' 버튼을 표시한다.
 * New 클릭 시 NewSessionModal을 연다.
 */

import { useDashboardStore, Button } from "@seosoyoung/soul-ui";
import { Plus } from "lucide-react";

export function SessionsTopBar() {
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
      <span className="text-sm font-semibold">Sessions</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openNewSessionModal('folder')}
        title="New session"
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        New
      </Button>
    </div>
  );
}
