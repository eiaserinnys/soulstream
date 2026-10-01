import React, { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useTokens } from '../theme';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { PlannerSectionHeader } from '../components/planner/PlannerSectionHeader';
import { CardBoard } from '../components/planner/CardBoard';
import { FolderCardList } from '../components/planner/FolderCardList';
import { CompletedCardsToggle } from '../components/planner/CompletedCardsToggle';
import { initialCards } from './fixtures';
import { useCardDisplay } from '../hooks/useCardDisplay';

type Scenario = 'mixed' | 'none' | 'all';
type Scope = 'folder' | 'global';
type Layout = 'rows' | 'board';
const exampleCards = initialCards.map((card) => ({ ...card,
  title: card.status === 'running' ? '긴 제목이 있어도 카드 폭과 전송 버튼이 줄지 않는 실행 카드' : `${card.title} · ${card.status}`,
  request: '보드에서 카드의 지시와 담당, 상태를 확인합니다.',
  latestActivity: { kind: card.status === 'review' ? 'report' as const : 'instruction' as const,
    body: card.status === 'review' ? '6열 보드 시안을 만들었습니다.\n완료 카드는 같은 토글로 표시합니다.' : '새 지시: 기존 카드 표현을 사용합니다.',
    format: 'markdown' as const, createdAt: card.updatedAt },
}));

export function ReviewBoard() {
  const t = useTokens();
  const { height } = useWindowDimensions();
  const [scenario, setScenario] = useState<Scenario>('mixed');
  const [scope, setScope] = useState<Scope>('folder');
  const [layout, setLayout] = useState<Layout>('board');
  const { includeCompleted, onChange: setIncludeCompleted } = useCardDisplay(scope === 'folder' ? initialCards[0].folderId : undefined);
  const [selected, setSelected] = useState('');
  const cards = scenario === 'none' ? exampleCards.filter((card) => card.status !== 'done')
    : scenario === 'all' ? exampleCards.filter((card) => card.status === 'done') : exampleCards;
  const completedCount = cards.filter((card) => card.status === 'done').length;
  return <View style={{ gap: t.uiSpacing.md }}>
    <SettingsSegmentedControl<Scenario> id="board-scenario" value={scenario} onChange={setScenario}
      options={[{ value: 'mixed', label: '혼합' }, { value: 'none', label: '완료 0개' }, { value: 'all', label: '전부 완료' }]} />
    <SettingsSegmentedControl<Scope> id="board-scope" value={scope} onChange={setScope}
      options={[{ value: 'folder', label: '현재 폴더' }, { value: 'global', label: '전체' }]} />
    <SettingsSegmentedControl<Layout> id="board-layout" value={layout} onChange={setLayout}
      options={[{ value: 'rows', label: '행보기' }, { value: 'board', label: '보드' }]} />
    <View testID="review-board-header" style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.md }}>
      <View style={{ flexGrow: 1 }}><PlannerSectionHeader title={scope === 'folder' ? '현재 폴더 · 카드' : '전체 · 보드'} /></View>
      <CompletedCardsToggle includeCompleted={includeCompleted} completedCount={completedCount} onChange={setIncludeCompleted} />
    </View>
    {layout === 'board' ? <View testID="review-board-frame" style={{ height: height - t.hitTarget.min * 2, minHeight: t.tabletShell.folderPane.minWidth }}>
      <CardBoard api={null} cards={cards} includeCompleted={includeCompleted} onOpen={setSelected} />
    </View> : <FolderCardList api={null} cards={cards} includeCompleted={includeCompleted} onOpen={setSelected} />}
    {selected ? <Text testID="review-board-selection" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>선택한 카드: {selected}</Text> : null}
  </View>;
}
