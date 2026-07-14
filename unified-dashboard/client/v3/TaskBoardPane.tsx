import { useEffect } from "react";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";

import { BoardWorkspaceView } from "../components/BoardWorkspaceView";

export function TaskBoardPane({
  runbookId,
  projectFolderId,
  sessions,
  onClose,
}: {
  runbookId: string;
  projectFolderId: string | null;
  sessions: readonly SessionSummary[];
  onClose(): void;
}) {
  useEffect(() => {
    const state = useDashboardStore.getState();
    const previous = {
      activeBoardContainer: state.activeBoardContainer,
      selectedFolderId: state.selectedFolderId,
      focusedBoardItem: state.focusedBoardItem,
      viewMode: state.viewMode,
      leftNavigationMode: state.leftNavigationMode,
      activeTab: state.activeTab,
    };
    state.openRunbookBoard(runbookId, projectFolderId);
    return () => { useDashboardStore.setState(previous); };
  }, [projectFolderId, runbookId]);

  return (
    <article className="v3-detail-pane v3-board-pane" data-testid="v3-task-board-pane">
      <header className="v3-workspace-toolbar">
        <button type="button" className="v3-workspace-back" onClick={onClose}>← 플래너</button>
        <strong>▦ 업무 보드</strong>
        <span className="v3-spacer" />
        <button type="button" className="v3-workspace-close" aria-label="업무 보드 닫기" onClick={onClose}>×</button>
      </header>
      <div className="v3-full-board">
        <BoardWorkspaceView sessions={[...sessions]} />
      </div>
    </article>
  );
}
