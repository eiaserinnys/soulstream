import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { CardBoardHeaderActions, CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { TabletPaneHeader } from '../components/split/TabletPaneHeader';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { CompletedCardsToggle } from '../components/planner/CompletedCardsToggle';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { DuoSideBandContext, DuoTopBandContext } from '../navigation/tabContract';
import { DuoRailOverride } from '../components/navigation/DuoRailOverride';
import { useRegisterDuoRailOverride } from '../navigation/phoneRailActions';
import { FolderSelectionSheet } from '../components/planner/FolderSelectionSheet';
import { SidebarPane } from '../components/split/SidebarPane';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { StarredFoldersWorkspace } from '../screens/StarredFoldersScreen';
import { usePlannerStarred } from '../hooks/usePlannerStarred';
import { usePlannerStore } from '../store/plannerStore';
import { useDeviceType, useTokens } from '../theme';
import { createReviewApi, makeCard, starredFolders } from './fixtures';

const modes = [
  { value: 'boardInternal', label: '내부 헤더' }, { value: 'boardExternal', label: '외부 헤더' },
  { value: 'starred', label: '별표' }, { value: 'sidebar', label: '사이드바' },
  { value: 'picker', label: '폴더 선택기' },
] as const;
type Mode = typeof modes[number]['value'];

function DuoRefreshReview({ api, board, begin, finish, phase, frame, includeCompleted }: { api: ApiClient; board: React.RefObject<CardBoardWorkspaceHandle | null>; begin(): void; finish(): void; phase: string; frame: 'outer-portrait' | 'inner-landscape'; includeCompleted: boolean }) {
  const t = useTokens();
  const size = frame === 'outer-portrait' ? { width: 466, height: 678 } : { width: 951, height: 669 };
  const insets = { top: 24, right: 84, bottom: 24, left: 0 };
  useRegisterDuoRailOverride('review-board', true, [
    { id: 'create', label: '드래프트 카드 추가', icon: 'add-outline', onPress: () => board.current?.openCreate() },
    { id: 'completed', label: '완료·취소 숨김', icon: 'eye-off-outline', onPress: () => {} },
  ]);
  return <DuoTopBandContext.Provider value={false}><SafeAreaFrameContext.Provider value={{ x: 0, y: 0, ...size }}>
    <SafeAreaInsetsContext.Provider value={insets}><DuoSideBandContext.Provider value={true}><ThemeProvider value={DefaultTheme}>
      <View testID="review-duo-refresh" style={{ width: size.width, height: size.height, overflow: 'hidden', backgroundColor: t.colors.background }}>
        <View style={{ flexDirection: 'row', gap: t.uiSpacing.sm }}>
          <GlassButton testID="duo-refresh-begin" onPress={begin}><Text>갱신 시작</Text></GlassButton>
          <GlassButton testID="duo-refresh-finish" onPress={finish}><Text>갱신 완료</Text></GlassButton>
          <GlassButton testID="duo-refresh-expand" onPress={() => board.current?.openExpanded()}><Text>보드 확대</Text></GlassButton>
          <Text testID="duo-refresh-phase">{phase}</Text>
        </View>
        <View style={{ flex: 1, paddingRight: insets.right }}><CardBoardWorkspace ref={board} api={api} externalHeader cardDisplay={{ includeCompleted, onChange: () => {} }} onOpen={() => {}} /></View>
        <DuoRailOverride />
      </View>
    </ThemeProvider></DuoSideBandContext.Provider></SafeAreaInsetsContext.Provider></SafeAreaFrameContext.Provider></DuoTopBandContext.Provider>;
}

/** Local deferred reads exercise the real owners; no shared fixture defaults or live transport. */
export function ReviewAutoRefresh() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const query = new URLSearchParams(window.location.search);
  const alignment = query.has('boardAlignment') || query.has('duoFrame');
  const manyCompleted = query.has('manyCompleted');
  // ?completedError: 첫 완료 조회 실패, ?completedError=refresh: 불러온 뒤 첫 갱신 실패.
  const completedError = query.has('completedError') ? query.get('completedError') === 'refresh' ? 'refresh' as const : 'initial' as const : undefined;
  const [refreshing, setRefreshing] = useState(false);
  const [includeCompleted, setIncludeCompleted] = useState(manyCompleted || completedError !== undefined);
  const [mode, setMode] = useState<Mode>('boardInternal');
  const [empty, setEmpty] = useState(false);
  const [phase, setPhase] = useState<'before' | 'pending' | 'after'>('before');
  const [cycles, setCycles] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = useRef<{ promise: Promise<void>; resolve(): void } | null>(null);
  const board = useRef<CardBoardWorkspaceHandle>(null);
  const api = useMemo(() => {
    const base = createReviewApi('normal', { manyCompleted, completedError });
    const statuses = alignment ? ['todo', 'running', 'blocked', 'awaiting_verification', 'review', 'on_hold'] as const : ['todo', 'review'] as const;
    const cards = empty ? [] : statuses.flatMap(status => Array.from({ length: 12 }, (_, index) => ({
      ...makeCard(status), id: `refresh-${status}-${index}`, title: `갱신 전후 같은 카드 ${index + 1}`,
      latestActivity: { kind: 'report' as const, body: '갱신 중에도 카드와 스크롤 위치를 유지합니다.', format: 'markdown' as const, createdAt: '2026-10-02T00:00:00Z' },
    })));
    const items = empty ? [] : Array.from({ length: 12 }, (_, index) => ({ ...starredFolders[0],
      page: { ...starredFolders[0].page, id: `refresh-folder-${index}`, title: `갱신 전후 같은 별표 폴더 ${index + 1}` },
      folderId: `refresh-folder-${index}`,
    }));
    return { ...base,
      listCards: async () => { await pending.current?.promise; return { cards }; },
      listCompletedCards: async params => { await pending.current?.promise; return base.listCompletedCards(params); },
      getStarredFolders: async () => { await pending.current?.promise; return { items, nextCursor: empty ? null : 'public-next' }; },
    } as ApiClient;
  }, [empty, alignment, manyCompleted, completedError]);
  // Sidebar's real owner is inactive here; this local read supplies its shared projection.
  usePlannerStarred(api, mode === 'sidebar');
  const begin = useCallback(() => {
    if (pending.current) return;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    pending.current = { promise, resolve };
    setPhase('pending');
    usePlannerStore.getState().invalidate('folder');
  }, [mode]);
  const finish = useCallback(() => {
    pending.current?.resolve(); pending.current = null;
    setPhase('after'); setCycles(value => value + 1);
  }, []);
  const frame = new URLSearchParams(window.location.search).get('duoFrame');
  if (frame === 'outer-portrait' || frame === 'inner-landscape') return <DuoRefreshReview api={api} board={board} begin={begin} finish={finish} phase={phase} frame={frame} includeCompleted={includeCompleted} />;
  return <View testID="review-auto-refresh" style={{ flex: 1 }}>
    <View style={{ padding: t.cardLayout.padding, gap: t.uiSpacing.sm }}>
      <SettingsSegmentedControl<Mode> id="refresh-owner" value={mode} options={modes} onChange={setMode} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
        <GlassButton testID="refresh-begin" disabled={phase === 'pending'} onPress={begin}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>자동 요청 시작</Text></GlassButton>
        <GlassButton testID="refresh-finish" disabled={phase !== 'pending'} onPress={finish}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>자동 요청 완료</Text></GlassButton>
        <GlassButton testID="refresh-empty" disabled={phase === 'pending'} onPress={() => setEmpty(value => !value)}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{empty ? '기본 목록' : '빈 목록'}</Text></GlassButton>
        {mode.startsWith('board') ? <GlassButton testID="refresh-expand" onPress={() => board.current?.openExpanded()}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>보드 확대</Text></GlassButton> : null}
        {mode === 'picker' ? <GlassButton testID="refresh-picker-open" onPress={() => setPickerOpen(true)}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>폴더 선택 열기</Text></GlassButton> : null}
      </View>
      <Text testID="refresh-phase" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{phase} · {cycles}회</Text>
      <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>시작·완료를 반복하여 같은 콘텐츠의 요청 전·중·후를 비교합니다. RN web 예시이며 네이티브 당김 표시는 렌더 트리에서 확인합니다.</Text>
    </View>
    {mode === 'boardExternal' ? <TabletPaneHeader testID={phone ? 'review-phone-card-header' : 'review-tablet-card-header'} style={phone ? { paddingHorizontal: t.cardLayout.padding } : undefined}>
      <Text testID="review-external-title" style={{ flex: 1, ...t.foundation.typography.section, color: t.colors.textPrimary }}>카드</Text>
      {phone ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
        <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.capsule} accessibilityLabel="드래프트 카드 추가" onPress={() => board.current?.openCreate()}><Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} /></LiquidGlassButton>
        <CompletedCardsToggle includeCompleted={includeCompleted} onChange={setIncludeCompleted} />
      </View> : <CardBoardHeaderActions cardDisplay={{ includeCompleted, onChange: setIncludeCompleted }} refreshing={refreshing}
        slotTestID="review-external-refresh-slot" onCreate={() => board.current?.openCreate()} onExpand={() => board.current?.openExpanded()} />}
    </TabletPaneHeader> : null}
    {mode.startsWith('board') ? <CardBoardWorkspace ref={board} api={api} externalHeader={mode === 'boardExternal'} onAutoRefreshChange={phone ? undefined : setRefreshing} cardDisplay={{ includeCompleted, onChange: setIncludeCompleted }} onOpen={() => {}} />
      : mode === 'starred' ? <StarredFoldersWorkspace api={api} />
        : mode === 'sidebar' ? <SidebarPane active={false} />
            : pickerOpen ? <FolderSelectionSheet api={api} onClose={() => setPickerOpen(false)} onSelect={() => {}} /> : null}
  </View>;
}
