import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens, useDeviceType } from '../theme';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
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
import { useUIStore } from '../store/uiStore';
import { createSessionSuccessionFailureRecord } from '../lib/session-succession-diagnostics';
import { operationId } from '../api/plannerMutationPort';
import { makeCard } from './fixtures';
import { dialogueApi as api, dialogueFolder, dialogueFolders } from './dialogue-fixtures';
import { dialogueSamples, type DialogueSample } from './dialogue-inventory';
import { ReviewSection } from './ReviewSection';
import { ReviewNativeDialogues } from './ReviewNativeDialogues';
import { ReviewDialogueOwners } from './ReviewDialogueOwners';

const assignment = { folderId: 'public-project', nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-model' };
export function ReviewDialogues() {
  const t = useTokens();
  const tablet = useDeviceType() !== 'phone';
  const text = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  const [selected, setSelected] = useState<DialogueSample>('card-create');
  const [opened, setOpened] = useState<DialogueSample | null>(null);
  const [instance, setInstance] = useState(0);
  const [result, setResult] = useState('');
  const [filters, setFilters] = useState({ ...DEFAULT_SEARCH_FILTERS });
  const close = () => setOpened(null);
  const saved = (message: string) => { setResult(message); close(); };
  return <>
    <ReviewSection title="iOS 다이얼로그">
      <Text style={text}>iOS 앱 컴포넌트의 웹 미리보기입니다. 원래 컴포넌트를 공개 예시로 엽니다. 저장은 메모리에만 남습니다.</Text>
      <Text style={text}>선택 행의 iOS 기본 메뉴는 웹에서 표시할 수 없습니다. 아래 기본 확인창 목록에서 문구와 종류를 확인합니다.</Text>
      <SettingsSegmentedControl<DialogueSample> id="review-dialogue" value={selected} onChange={setSelected} options={dialogueSamples} wrap />
      <GlassButton accessibilityLabel="선택한 다이얼로그 열기" onPress={() => { setResult(''); setInstance(value => value + 1); setOpened(selected); }}>
        <Text style={text}>{dialogueSamples.find(sample => sample.value === selected)?.label} 열기</Text>
      </GlassButton>
      {result ? <Text testID="review-dialogue-result" style={text}>{result}</Text> : null}
      {opened === 'card-create' ? <CardCreateSheet api={api} folderId="public-project" onClose={close} /> : null}
      {opened === 'assignment' ? <CardAssignmentSheet api={api} value={assignment} mode="edit" onClose={close} onSave={async value => saved('메모리 담당: ' + value.agentId)} /> : null}
      {opened === 'folder-picker' ? <FolderSelectionSheet api={api} onClose={close} onSelect={id => saved('선택: ' + id)} /> : null}
      {opened === 'execution-picker' ? <ExecutionSelectionSheet api={api} value={assignment} onClose={close} onSave={value => saved('메모리 실행: ' + value.agentId)} /> : null}
      {opened === 'folder-create' ? <NewFolderSheet visible api={api} folders={dialogueFolders} dailyDate="2026-10-03" defaultProjectPageId="public-page" onClose={close}
        onSubmit={async input => { const response = await api.createFolder({ name: input.title, description: input.description, parentFolderId: input.folderId, initialContext: input.initialContext, idempotencyKey: operationId('review-folder') }); saved('메모리 폴더: ' + response.folder.name); return response; }} /> : null}
      {opened === 'session-create' ? <SessionSuccessionSheet visible api={api} folder={dialogueFolder} predecessorSessionId="public-idle" onClose={close} onCreated={id => saved('메모리 세션: ' + id)} /> : null}
      {opened === 'session-diagnostic' ? <SessionSuccessionDiagnosticFallback visible api={api} folder={dialogueFolder} predecessorSessionId="public-idle" onClose={close} onCreated={id => saved('메모리 진단 세션: ' + id)}
        failure={createSessionSuccessionFailureRecord({ folderId: 'public-project', folderPageId: 'public-page', projectPageId: 'public-page', phase: 'render', error: new Error('공개 예시: 새 세션 화면을 열지 못했습니다.'), visible: true, predecessorSessionId: 'public-idle', folderBlockCount: 0, folderSessionCount: 1 })} /> : null}
      {opened === 'morning-review' ? <MorningReviewSheet visible api={api} today="2026-10-03" onClose={close} onAction={async (_, action) => { setResult('메모리 검토: ' + action); }} /> : null}
      {opened === 'search-filter' ? <SearchFilterModal visible tablet={tablet} filters={filters} folders={dialogueFolders} nodeIds={['public-node']} backends={['codex', 'claude']}
        onChange={value => { setFilters(current => ({ ...current, ...value })); setResult('검색 필터 변경'); }} onClose={close} /> : null}
      {opened === 'settings' ? <SettingsModal visible onClose={close} /> : null}
      {opened === 'card-status' ? <CardStatusMenu api={api} card={makeCard('todo')} onClose={close} /> : null}
      {opened === 'image-viewer' ? <ImageViewerModal sources={[require('../../assets/icon.png')]} initialIndex={0} onClose={close} /> : null}
      <ReviewDialogueOwners key={instance} opened={opened} />
    </ReviewSection>
    <ReviewSection title="카드·폴더·세션 상세 오버레이">
      <Text style={text}>독립 Modal이 아닌 앱의 실제 상세 오버레이입니다.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
        <GlassButton accessibilityLabel="카드 상세 오버레이 열기" onPress={() => useUIStore.getState().openCardOverlay('public-todo')}><Text style={text}>카드 상세</Text></GlassButton>
        <GlassButton accessibilityLabel="폴더 상세 오버레이 열기" onPress={() => useUIStore.getState().openFolderOverlay('public-page')}><Text style={text}>폴더 상세</Text></GlassButton>
        <GlassButton accessibilityLabel="세션 상세 오버레이 열기" onPress={() => useUIStore.getState().openSessionOverlay('public-idle')}><Text style={text}>세션 상세</Text></GlassButton>
      </View>
    </ReviewSection>
    <ReviewNativeDialogues />
  </>;
}
