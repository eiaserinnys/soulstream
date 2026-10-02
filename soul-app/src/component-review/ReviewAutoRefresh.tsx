import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../components/planner/CardBoardWorkspace';
import { FolderSelectionSheet } from '../components/planner/FolderSelectionSheet';
import { SidebarPane } from '../components/split/SidebarPane';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { StarredFoldersWorkspace } from '../screens/StarredFoldersScreen';
import { DailyPlannerScreen } from '../screens/DailyPlannerScreen';
import { usePlannerStarred } from '../hooks/usePlannerStarred';
import { usePlannerStore } from '../store/plannerStore';
import { useTokens } from '../theme';
import { createReviewApi, makeCard, starredFolders } from './fixtures';

const modes = [
  { value: 'boardInternal', label: '내부 헤더' }, { value: 'boardExternal', label: '외부 헤더' },
  { value: 'starred', label: '별표' }, { value: 'sidebar', label: '사이드바' },
  { value: 'picker', label: '폴더 선택기' }, { value: 'daily', label: '데일리 불변' },
] as const;
type Mode = typeof modes[number]['value'];

/** Local deferred reads exercise the real owners; no shared fixture defaults or live transport. */
export function ReviewAutoRefresh() {
  const t = useTokens();
  const [mode, setMode] = useState<Mode>('boardInternal');
  const [empty, setEmpty] = useState(false);
  const [phase, setPhase] = useState<'before' | 'pending' | 'after'>('before');
  const [cycles, setCycles] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = useRef<{ promise: Promise<void>; resolve(): void } | null>(null);
  const board = useRef<CardBoardWorkspaceHandle>(null);
  const api = useMemo(() => {
    const base = createReviewApi();
    const cards = empty ? [] : ['todo', 'review'].flatMap(status => Array.from({ length: 12 }, (_, index) => ({
      ...makeCard(status as 'todo' | 'review'), id: `refresh-${status}-${index}`, title: `갱신 전후 같은 카드 ${index + 1}`,
      latestActivity: { kind: 'report' as const, body: '갱신 중에도 카드와 스크롤 위치를 유지합니다.', format: 'markdown' as const, createdAt: '2026-10-02T00:00:00Z' },
    })));
    const items = empty ? [] : Array.from({ length: 12 }, (_, index) => ({ ...starredFolders[0],
      page: { ...starredFolders[0].page, id: `refresh-folder-${index}`, title: `갱신 전후 같은 별표 폴더 ${index + 1}` },
      folderId: `refresh-folder-${index}`,
    }));
    return { ...base,
      listCards: async () => { await pending.current?.promise; return { cards }; },
      getStarredFolders: async () => { await pending.current?.promise; return { items, nextCursor: empty ? null : 'public-next' }; },
    } as ApiClient;
  }, [empty]);
  // Sidebar's real owner is inactive here; this local read supplies its shared projection.
  usePlannerStarred(api, mode === 'sidebar');
  const begin = useCallback(() => {
    if (pending.current) return;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    pending.current = { promise, resolve };
    setPhase('pending');
    if (mode === 'daily') usePlannerStore.getState().setLoading('daily:2026-10-02', true);
    else usePlannerStore.getState().invalidate('folder');
  }, [mode]);
  const finish = useCallback(() => {
    pending.current?.resolve(); pending.current = null;
    usePlannerStore.getState().setLoading('daily:2026-10-02', false);
    setPhase('after'); setCycles(value => value + 1);
  }, []);
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
    {mode.startsWith('board') ? <CardBoardWorkspace ref={board} api={api} externalHeader={mode === 'boardExternal'} cardDisplay={{ includeCompleted: false, onChange: () => {} }} onOpen={() => {}} />
      : mode === 'starred' ? <StarredFoldersWorkspace api={api} />
        : mode === 'sidebar' ? <SidebarPane active={false} />
          : mode === 'daily' ? <DailyPlannerScreen active={false} date="2026-10-02" />
            : pickerOpen ? <FolderSelectionSheet api={api} onClose={() => setPickerOpen(false)} onSelect={() => {}} /> : null}
  </View>;
}
