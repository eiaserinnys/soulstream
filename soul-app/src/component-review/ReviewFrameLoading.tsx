import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { FrameLoading } from '../components/FrameLoading';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { FolderCards } from '../components/planner/FolderCards';
import { SettingsSection } from '../components/settings/SettingsSection';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { SessionFeedScreen } from '../screens/SessionFeedScreen';
import { StarredFoldersWorkspace } from '../screens/StarredFoldersScreen';
import { useSessionStore } from '../store/sessionStore';
import { useTokens } from '../theme';
import { createReviewApi } from './fixtures';

const modes = [
  { value: 'frame', label: '고정 프레임' },
  { value: 'frameBare', label: '글자 없음' },
  { value: 'settings', label: '설정 섹션' },
  { value: 'board', label: '보드 첫 로딩' },
  { value: 'boardExpanded', label: '확대 보드' },
  { value: 'completedLane', label: '완료 칸 첫 로딩' },
  { value: 'completedFirst', label: '완료 먼저' },
  { value: 'starred', label: '별표 폴더' },
  { value: 'folderCards', label: '폴더 카드' },
  { value: 'feed', label: '세션 피드' },
  { value: 'cardDetail', label: '카드 상세' },
] as const;
type Mode = typeof modes[number]['value'];

/** 첫 로딩 표본. 실제 소유 컴포넌트에 응답을 붙잡아 둔 API를 넘겨 로딩 상태를 만든다. */
export function ReviewFrameLoading() {
  const t = useTokens();
  const [mode, setMode] = useState<Mode>('frame');
  const board = useRef<CardBoardWorkspaceHandle>(null);

  const pendingApi = useMemo(() => {
    const never = () => new Promise<never>(() => {});
    return {
      ...createReviewApi(),
      listCards: never,
      getStarredFolders: never,
      getFolderSnapshot: never,
      getCard: never,
    } as unknown as ApiClient;
  }, []);

  const completedPendingApi = useMemo(() => ({
    ...createReviewApi(),
    listCompletedCards: () => new Promise<never>(() => {}),
  }) as unknown as ApiClient, []);
  const activePendingApi = useMemo(() => ({
    ...createReviewApi(),
    listCards: () => new Promise<never>(() => {}),
  }) as unknown as ApiClient, []);

  useEffect(() => {
    if (mode !== 'boardExpanded' && mode !== 'completedLane' && mode !== 'completedFirst') return;
    board.current?.openExpanded();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'feed') return;
    useSessionStore.setState({ catalogLoadState: 'loading' });
    return () => { useSessionStore.setState({ catalogLoadState: 'ready' }); };
  }, [mode]);

  const content = () => {
    if (mode === 'frame' || mode === 'frameBare') {
      return <View testID="frame-loading-sample" style={{
        height: t.foundation.minHeight.row * 3,
        justifyContent: 'center',
        borderRadius: t.foundation.radius.root,
        backgroundColor: t.colors.surfaceMuted,
      }}>
        <FrameLoading testID="frame-loading-sample-loader" text={mode === 'frame' ? '불러오는 중…' : undefined} />
      </View>;
    }
    if (mode === 'settings') {
      return <SettingsSection id="frame-loading" title="프레임 로딩" flattened={false}>
        <FrameLoading testID="frame-loading-settings-loader" text="불러오는 중…" inline />
      </SettingsSection>;
    }
    if (mode === 'board' || mode === 'boardExpanded') {
      return <CardBoardWorkspace ref={board} api={pendingApi} cardDisplay={{ includeCompleted: false, onChange: () => {} }} onOpen={() => {}} />;
    }
    if (mode === 'completedLane' || mode === 'completedFirst') {
      return <CardBoardWorkspace ref={board} api={mode === 'completedLane' ? completedPendingApi : activePendingApi}
        cardDisplay={{ includeCompleted: true, onChange: () => {} }} onOpen={() => {}} />;
    }
    if (mode === 'starred') return <StarredFoldersWorkspace api={pendingApi} />;
    if (mode === 'folderCards') return <FolderCards api={pendingApi} folderId="frame-loading-folder" />;
    if (mode === 'feed') return <SessionFeedScreen active={false} />;
    return <View style={{ flex: 1 }}><CardDetailContent api={pendingApi} cardId="frame-loading-card" onClose={() => {}} inline /></View>;
  };

  return <View testID="review-frame-loading" style={{ flex: 1 }}>
    <View style={{ padding: t.cardLayout.padding, gap: t.uiSpacing.sm }}>
      <SettingsSegmentedControl<Mode> wrap id="frame-loading-mode" value={mode} options={modes} onChange={setMode} />
      <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>스피너 왼쪽, 짧은 글자 오른쪽의 한 줄 묶음이 프레임 가운데에 섭니다. 응답을 붙잡아 둔 실제 컴포넌트로 첫 로딩을 재현합니다.</Text>
    </View>
    <View style={{ flex: 1, paddingHorizontal: t.cardLayout.padding, paddingBottom: t.cardLayout.padding }}>
      {content()}
    </View>
  </View>;
}
