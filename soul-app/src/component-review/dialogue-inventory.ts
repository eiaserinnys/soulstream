// One entry per live Modal owner. Child sheets retain their own entry even
// when reachable through a parent; the gallery renders the original owner.
export const dialogueSamples = [
  { value: 'card-create', label: '새 카드', source: 'planner/CardCreateSheet.tsx' },
  { value: 'assignment', label: '카드 담당', source: 'planner/CardAssignmentSheet.tsx' },
  { value: 'folder-picker', label: '폴더 선택', source: 'planner/FolderSelectionSheet.tsx' },
  { value: 'execution-picker', label: '실행 선택', source: 'planner/ExecutionSelectionSheet.tsx' },
  { value: 'folder-create', label: '새 폴더', source: 'planner/NewFolderSheet.tsx' },
  { value: 'session-create', label: '새 세션·승계', source: 'planner/SessionSuccessionSheet.tsx' },
  { value: 'session-diagnostic', label: '세션 실패 진단', source: 'planner/SessionSuccessionDiagnosticFallback.tsx' },
  { value: 'morning-review', label: '오늘 검토', source: 'planner/MorningReviewSheet.tsx' },
  { value: 'search-filter', label: '검색 필터', source: 'search/SearchFilterModal.tsx' },
  { value: 'settings', label: '설정', source: 'settings/SettingsModal.tsx' },
  { value: 'task-output', label: '작업 출력', source: 'chat/ClaudeRuntimeTasksStrip.tsx' },
  { value: 'board-expanded', label: '카드 보드 확대', source: 'planner/CardBoardWorkspace.tsx' },
  { value: 'card-status', label: '카드 상태 메뉴', source: 'planner/CardStatusMenu.tsx' },
  { value: 'image-viewer', label: '이미지 확대', source: 'ImageViewerModal.tsx' },
] as const;
export type DialogueSample = typeof dialogueSamples[number]['value'];

export const dialogueDetailSamples = [
  { value: 'card-detail', label: '카드 상세' },
  { value: 'folder-detail', label: '폴더 상세' },
  { value: 'session-detail', label: '세션 상세' },
] as const;
export type DialoguePreviewSample = DialogueSample | typeof dialogueDetailSamples[number]['value'];
const previewSamples = [...dialogueSamples, ...dialogueDetailSamples];
export const dialoguePreviewGroups = [
  { id: 'create', title: '생성', ids: ['card-create', 'folder-create', 'session-create'] },
  { id: 'select', title: '선택과 담당', ids: ['assignment', 'folder-picker', 'execution-picker', 'search-filter'] },
  { id: 'status', title: '상태와 확인', ids: ['card-status', 'session-diagnostic', 'morning-review'] },
  { id: 'settings', title: '설정과 출력', ids: ['settings', 'task-output'] },
  { id: 'expand', title: '확대', ids: ['board-expanded', 'image-viewer'] },
  { id: 'detail', title: '상세', ids: ['card-detail', 'folder-detail', 'session-detail'] },
].map(group => ({ id: group.id, title: group.title, items: group.ids.map(id => {
  const sample = previewSamples.find(item => item.value === id);
  if (!sample) throw new Error('등록되지 않은 검수 샘플: ' + id);
  return sample;
}) }));

export function getDialoguePreviewSample(search: string): DialoguePreviewSample | null {
  const query = new URLSearchParams(search);
  if (query.get('section') !== 'dialogues') return null;
  return previewSamples.find(sample => sample.value === query.get('sample'))?.value ?? null;
}

export const nativeConfirmations = [
  { title: '폴더 보관', message: '폴더와 내용을 보존하고 목록에서 숨깁니다.', confirmText: '보관', source: 'planner/projectManagement.ts' },
  { title: '카드 완료 처리', message: '카드를 물리 삭제하지 않고 완료 상태로 전환합니다.', confirmText: '확인', source: 'hooks/usePlannerContextMenus.ts' },
  { title: '세션 삭제', message: '이 세션을 삭제합니다.', confirmText: '확인', source: 'hooks/usePlannerContextMenus.ts' },
  { title: '토큰 삭제', message: '저장된 인증 토큰을 삭제합니다. 계속하시겠습니까?', confirmText: '삭제', source: 'settings/ClaudeProviderSection.tsx' },
] as const;
export const nativeRenames = ['프로젝트 이름 변경', '폴더 이름 변경', '세션 이름 변경'] as const;
export const nativeMenuTypes = [
  '프로젝트·폴더·세션 관리와 이동 대상 선택',
  '노드·에이전트·모델·추론 수준 선택',
  '새 폴더의 상위 폴더와 초기 컨텍스트 선택',
  '첨부의 사진·파일 선택', '대화 이벤트 복사 메뉴',
] as const;
// General failure notifications share Alert.alert and are not separate forms.
export const alertOwners = [
  'components/chat/ChatBody.tsx',
  'components/chat/ClaudeRuntimeSchedulesStrip.tsx',
  'components/chat/ClaudeRuntimeTasksStrip.tsx',
  'components/chat/RealtimeVoiceControls.tsx',
  'components/chat/useClaudeRuntimeListRefresh.ts',
  'components/events/EventContextMenu.tsx',
  'components/menus/AppContextMenu.tsx',
  'components/planner/CardBoard.tsx',
  'components/planner/CardDetailSheet.tsx',
  'components/planner/FolderWorkspace.tsx',
  'components/planner/ProjectContextEditorView.tsx',
  'components/planner/SessionSuccessionSheet.tsx',
  'components/planner/TodayCardComposer.tsx',
  'components/planner/plannerNativeUI.ts',
  'components/planner/projectManagement.ts',
  'components/settings/ClaudeProviderSection.tsx',
  'components/settings/RecurringJobViews.tsx',
  'hooks/useCardActions.ts',
  'hooks/useCardComments.ts',
  'hooks/useChatAttachments.ts',
  'hooks/usePlannerContextMenus.ts',
  'navigation/RootNavigator.tsx',
  'navigation/phoneSessionNavigation.ts',
  'screens/DailyPlannerScreen.tsx',
  'screens/SettingsScreen.tsx',
  'screens/StarredFoldersScreen.tsx',
] as const;
