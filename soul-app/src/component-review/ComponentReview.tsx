import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useDeviceType, useTokens } from '../theme';
import { useSessionStore } from '../store/sessionStore';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { ReviewRows } from './ReviewRows';
import { ReviewChat } from './ReviewChat';
import { ReviewProject } from './ReviewProject';
import { ReviewNativeSettings } from './ReviewNativeSettings';
import { ReviewSettings } from './ReviewSettings';
import { ReviewSurfaces } from './ReviewSurfaces';
import { ReviewBoard } from './ReviewBoard';
import { ReviewBoardActions } from './ReviewBoardActions';
import { ReviewPostIt } from './ReviewPostIt';
import { ReviewCardColors } from './ReviewCardColors';
import { ReviewBoardWorkspace } from './ReviewBoardWorkspace';
import { ReviewCardHome } from './ReviewCardHome';
import {ReviewFolderWorkspace} from './ReviewFolderWorkspace';
import { ReviewFolderTabs } from './ReviewFolderTabs';
import { ReviewEntryShell } from './ReviewEntryShell';
import { ReviewLongFolders } from './ReviewLongFolders';
import { ReviewAutoRefresh } from './ReviewAutoRefresh';
import { ReviewCardImages } from './ReviewCardImages';
import { folders, folderTabReviewFolders } from './fixtures';
import { getDialoguePreviewSample } from './dialogue-inventory';
import { ReviewDialoguePreview } from './ReviewDialoguePreview';
import { ReviewDialogues } from './ReviewDialogues';
import { dialogueFolders, dialogueSessions, reviewSessionPortraits } from './dialogue-fixtures';
import { useUIStore } from '../store/uiStore';
import { FolderWorkspaceReadOverlay } from '../components/planner/FolderWorkspaceReadOverlay';

const sections = [
  { value: 'rows', label: '행' }, { value: 'chat', label: '대화' },
  { value: 'project', label: '프로젝트' }, { value: 'settings', label: '선택·설정' },
  { value: 'nativeSettings', label: '앱 설정' },
  { value: 'surfaces', label: '표면' },
  { value: 'board', label: '보드' },
  { value: 'boardActions', label: '보드 액션' },
  { value: 'postit', label: '포스트잇' },
  { value: 'cardColors', label: '카드 색상' },
  { value: 'boardConnected', label: '보드 연결' },
  { value: 'cardHome', label: '카드 홈' },
  {value:'folderWorkspace',label:'폴더 카드'},
  { value: 'folderTabs', label: '폴더 탭' },
  { value: 'entryShell', label: '앱 홈 조합' },
  { value: 'longFolders', label: '긴 폴더 목록' },
  { value: 'autoRefresh', label: '자동 갱신' },
  { value: 'cardImages', label: '카드 이미지' },
  { value: 'dialogues', label: '다이얼로그' },
] as const;
type Section = typeof sections[number]['value'];

export function initializeReview() {
  const entryShell = typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('section') === 'entryShell';
  const folderTabs = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('section') === 'folderTabs';
  const cardImages = typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('section') === 'cardImages';
  const nativeSettings = typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('section') === 'nativeSettings';
  const firstNativeConnection = nativeSettings && new URLSearchParams(window.location.search).get('entry') === 'first';
  const dialogues = typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('section') === 'dialogues';
  useSettingsStore.setState({ serverUrl: firstNativeConnection ? '' : cardImages ? window.location.origin : entryShell || folderTabs || dialogues || nativeSettings ? 'https://public-fixture.invalid' : '', nodeId: 'public-node', appearance: typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('theme') === 'dark' ? 'dark' : 'light' });
  if (nativeSettings) {
    useAuthStore.setState({ jwt: firstNativeConnection ? null : 'public-review-fixture', authRejected: false });
    if (new URLSearchParams(window.location.search).get('state') === 'photo-error') useSettingsStore.setState({ wallpaper: { mode: 'photo', customImage: window.location.origin + '/assets/ios-components/unavailable-photo.jpg' } });
    if (new URLSearchParams(window.location.search).get('state') === 'photo-fallback') useSettingsStore.setState({ wallpaper: { mode: 'photo' } });
  }
  const longSelection = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('chips') === 'long';
  if (longSelection) useSettingsStore.setState({ cardAssignments: {
    [entryShell ? 'https://public-fixture.invalid' : '']: { folderId: folders[0].id, nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-exhausted-model' },
  } });
  const fixtureSessions = Object.fromEntries(reviewSessionPortraits(dialogueSessions).map(session => [session.agentSessionId, session]));
  useSessionStore.setState({ catalog: { folders: folderTabs ? (new URLSearchParams(window.location.search).get('state') === 'empty' ? [] : folderTabReviewFolders) : dialogues ? dialogueFolders : longSelection ? folders.map((folder, index) => index === 0 ? { ...folder, name: '아주 긴 프로젝트 폴더 이름으로 한 줄 말줄임을 확인합니다' } : folder) : folders, sessions: dialogues ? fixtureSessions : {} }, ...(dialogues ? { sessions: fixtureSessions } : {}), catalogLoadState: 'ready' });
}

function Gallery() {
  const overlayVisible = useUIStore(state => state.folderOverlayVisible);
  const t = useTokens();
  const { width, height } = useWindowDimensions();
  const device = useDeviceType();
  const [section, setSection] = useState<Section>(() => {
    const selected = typeof window !== 'undefined' ? new URLSearchParams(window.location?.search).get('section') : null;
    return sections.some((entry) => entry.value === selected) ? selected as Section : 'rows';
  });
  const style = useMemo(() => ({
    padding: t.cardLayout.padding, gap: t.uiSpacing.xl,
    backgroundColor: t.colors.background,
  }), [t]);
  if (section === 'nativeSettings') return <ReviewNativeSettings/>;
  if (section === 'cardHome') return <View style={{ flex: 1, padding: t.uiSpacing.sm, backgroundColor: t.colors.background }}><ReviewCardHome /></View>;
  if (section === 'cardColors') return <ReviewCardColors />;
  if (section === 'boardConnected') return <View style={{flex:1,padding:t.uiSpacing.sm,backgroundColor:t.colors.background}}><ReviewBoardWorkspace/></View>;
  if (section === 'board') return <View style={{flex:1,padding:t.uiSpacing.sm,backgroundColor:t.colors.background}}><ReviewBoard/></View>;
  if(section==='folderWorkspace')return <View style={{flex:1,backgroundColor:t.colors.background}}><ReviewFolderWorkspace/></View>;
  if (section === 'folderTabs') return <View style={{ flex: 1, backgroundColor: t.colors.background }}><ReviewFolderTabs /></View>;
  if (section === 'entryShell') return <View style={{ flex: 1, backgroundColor: t.colors.background }}><ReviewEntryShell /></View>;
  if (section === 'longFolders') return <View style={{ flex: 1, backgroundColor: t.colors.background }}><ReviewLongFolders /></View>;
  if (section === 'autoRefresh') return <View style={{ flex: 1, backgroundColor: t.colors.background }}><ReviewAutoRefresh /></View>;
  return <View style={{ flex: 1 }}><ScrollView testID="component-review" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={style} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    <View style={{ gap: t.spacing.sm }}>
      <Text accessibilityRole="header" style={{ ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>
        앱 컴포넌트 검수
      </Text>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>
        공개 예시입니다. 변경은 새로고침하면 초기화됩니다.
      </Text>
      <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }} testID="review-viewport">
        현재 화면 {Math.round(width)} × {Math.round(height)} · {device}
      </Text>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>
        웹 유리 표면은 앱의 대체 표현입니다. iOS 유리 효과와 키보드는 실제 앱에서 확인합니다.
      </Text>
    </View>
    <SettingsSegmentedControl<Section> id="review-section" value={section} onChange={(next) => {
      if (next === 'dialogues' || section === 'dialogues' || next === 'nativeSettings') {
        const url = new URL(window.location.href);
        url.searchParams.set('section', next);
        window.history.replaceState(null, '', url);
        initializeReview();
      }
      if (next === 'entryShell' || next === 'folderTabs') useSettingsStore.setState({ serverUrl: 'https://public-fixture.invalid' });
      if (next === 'cardImages') useSettingsStore.setState({ serverUrl: window.location.origin });
      setSection(next);
    }} options={sections} wrap={section === 'dialogues'} />
    {section === 'dialogues' ? <ReviewDialogues /> : null}
    {section === 'rows' ? <ReviewRows /> : section === 'chat' ? <ReviewChat />
      : section === 'cardImages' ? <ReviewCardImages serverUrl={window.location.origin} bundledImages />
      : section === 'project' ? <ReviewProject /> : section === 'settings' ? <ReviewSettings />
        : section === 'boardActions' ? <ReviewBoardActions />
          : section === 'postit' ? <ReviewPostIt /> : section === 'dialogues' ? null : <ReviewSurfaces />}
  </ScrollView>{section === 'dialogues' && overlayVisible ? <FolderWorkspaceReadOverlay /> : null}</View>;
}

export function ComponentReview() {
  const sample = typeof window !== 'undefined' ? getDialoguePreviewSample(window.location.search) : null;
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>{sample ? <ReviewDialoguePreview sample={sample} /> : <Gallery />}</SafeAreaProvider></GestureHandlerRootView>;
}
