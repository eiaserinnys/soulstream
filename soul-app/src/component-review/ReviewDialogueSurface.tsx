import React, { useState } from 'react';
import { useDeviceType } from '../theme';
import { CardCreateSheet } from '../components/planner/CardCreateSheet';
import { CardAssignmentSheet } from '../components/planner/CardAssignmentSheet';
import { FolderSelectionSheet } from '../components/planner/FolderSelectionSheet';
import { ExecutionSelectionSheet } from '../components/planner/ExecutionSelectionSheet';
import { NewFolderSheet } from '../components/planner/NewFolderSheet';
import { SessionSuccessionSheet } from '../components/planner/SessionSuccessionSheet';
import { SessionSuccessionDiagnosticFallback } from '../components/planner/SessionSuccessionDiagnosticFallback';
import { MorningReviewSheet } from '../components/planner/MorningReviewSheet';
import { SearchFilterModal } from '../components/search/SearchFilterModal';
import { SettingsModal } from '../components/settings/SettingsModal';
import { CardStatusMenu } from '../components/planner/CardStatusMenu';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { DEFAULT_SEARCH_FILTERS } from '../store/searchStore';
import { createSessionSuccessionFailureRecord } from '../lib/session-succession-diagnostics';
import { createPlannerMutationPort } from '../api/plannerMutationPort';
import { makeCard } from './fixtures';
import { dialogueApi as api, dialogueFolder, dialogueFolders } from './dialogue-fixtures';
import { type DialogueSample } from './dialogue-inventory';
import { ReviewDialogueOwners } from './ReviewDialogueOwners';

const assignment = { folderId: 'public-project', nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-model' };

// Both the section and single-frame preview mount the same original owners.
export function ReviewDialogueSurface({ opened, onClose, onResult, preview = false }: {
  opened: DialogueSample | null; onClose(): void; onResult(message: string): void; preview?: boolean;
}) {
  const tablet = useDeviceType() !== 'phone';
  const [filters, setFilters] = useState({ ...DEFAULT_SEARCH_FILTERS });
  const close = onClose;
  const setResult = onResult;
  const saved = (message: string) => { setResult(message); close(); };
  return <>
      {opened === 'card-create' ? <CardCreateSheet api={api} folderId="public-project" onClose={close} /> : null}
      {opened === 'assignment' ? <CardAssignmentSheet api={api} value={assignment} mode="edit" onClose={close} onSave={async value => saved('메모리 담당: ' + value.agentId)} /> : null}
      {opened === 'folder-picker' ? <FolderSelectionSheet api={api} onClose={close} onSelect={id => saved('선택: ' + id)} /> : null}
      {opened === 'execution-picker' ? <ExecutionSelectionSheet api={api} value={assignment} onClose={close} onSave={value => saved('메모리 실행: ' + value.agentId)} /> : null}
      {opened === 'folder-create' ? <NewFolderSheet visible api={api} folders={dialogueFolders} dailyDate="2026-10-03" defaultProjectPageId="public-page" onClose={close}
        onSubmit={async input => { const response = await createPlannerMutationPort(api).createFolder(input); setResult('메모리 폴더: ' + response.folder.name); return response; }} /> : null}
      {opened === 'session-create' ? <SessionSuccessionSheet visible api={api} folder={dialogueFolder} predecessorSessionId="public-idle" onClose={close} onCreated={id => setResult('메모리 세션: ' + id)} /> : null}
      {opened === 'session-diagnostic' ? <SessionSuccessionDiagnosticFallback visible api={api} folder={dialogueFolder} predecessorSessionId="public-idle" onClose={close} onCreated={id => saved('메모리 진단 세션: ' + id)}
        failure={createSessionSuccessionFailureRecord({ folderId: 'public-project', folderPageId: 'public-page', projectPageId: 'public-page', phase: 'render', error: new Error('공개 예시: 새 세션 화면을 열지 못했습니다.'), visible: true, predecessorSessionId: 'public-idle', folderBlockCount: 0, folderSessionCount: 1 })} /> : null}
      {opened === 'morning-review' ? <MorningReviewSheet visible api={api} today="2026-10-03" onClose={close} onAction={async (_, action) => { setResult('메모리 검토: ' + action); }} /> : null}
      {opened === 'search-filter' ? <SearchFilterModal visible tablet={tablet} filters={filters} folders={dialogueFolders} nodeIds={['public-node']} backends={['codex', 'claude']}
        onChange={value => { setFilters(current => ({ ...current, ...value })); setResult('검색 필터 변경'); }} onClose={close} /> : null}
      {opened === 'settings' ? <SettingsModal visible onClose={close} /> : null}
      {opened === 'card-status' ? <CardStatusMenu api={api} card={makeCard('todo')} onClose={close} /> : null}
      {opened === 'image-viewer' ? <ImageViewerModal sources={[require('../../assets/icon.png')]} initialIndex={0} onClose={close} /> : null}
      <ReviewDialogueOwners opened={opened} preview={preview} onClose={close} />
  </>;
}
