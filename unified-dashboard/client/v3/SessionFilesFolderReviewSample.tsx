import { FolderWorkspace } from './FolderWorkspace';
import { SessionMenuProvider } from './SessionMenuProvider';
import { reviewFolder, reviewFolders, reviewSession } from './components-review-fixtures';
import { useLayoutEffect } from 'react';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import { activateRunSession } from './folder-workspace-run-model';
import { useMobilePlannerMode } from './MobilePlannerTabs';

/** 실제 폴더 작업면에서 세션 파일 칸을 검수한다. */
export function SessionFilesFolderReviewSample() {
  const mobileMode = useMobilePlannerMode();
  useLayoutEffect(() => { activateRunSession(reviewSession, useDashboardStore.getState()); }, []);
  return <SessionMenuProvider sessions={[reviewSession]} onRename={async()=>{}} onDelete={async()=>{}} onMove={async()=>{}} onCreated={()=>{}}><FolderWorkspace
    task={reviewFolder('소울스트림', 'components-folder')} folderSections={null} parentFolder={null} onOpenParent={()=>{}}
    folderResolutionError={null} projectTitle="소울스트림" projectFolderId="components-folder" folders={reviewFolders}
    contextInvalidationKey={0} sessions={[reviewSession]} runSessionLoadStates={new Map()} runHistoryTotal={1}
    runHistoryHasMore={false} runHistoryLoading={false} onLoadMoreRuns={async()=>{}} activeSession={reviewSession}
    focusRequest={null} onFocusRequestHandled={()=>{}} chatOpen chatInputDisabled={false} fileUploadUrl={undefined} sessionDefaults={null}
    mobileMode={mobileMode} mobileTab="chat" historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected"
    reconnectSession={()=>{}} onChatVisibilityChange={()=>{}} folderMoveTargets={[]} onReturnToToday={()=>{}}
    onCloseWorkspace={()=>{}} onCloseChat={()=>{}} onOpenSession={()=>{}}
    onRenameFolderTitle={async title=>title} onSaveDescription={async()=>{}} onFolderBlocksChanged={()=>{}}
    onAcknowledgedReview={()=>{}} markdownDocumentsRevision={0} onMarkdownDocumentEditorClosed={()=>{}} />
  </SessionMenuProvider>;
}
