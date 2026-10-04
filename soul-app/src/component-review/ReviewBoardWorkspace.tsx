import React, { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useTokens } from '../theme';
import { createReviewApi, initialCards } from './fixtures';
import { useCardDisplay } from '../hooks/useCardDisplay';
import { useCardStore } from '../store/cardStore';

/** Real board inventory/rendering with a local API; no production transport. */
export function ReviewBoardWorkspace() {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const [scenario, setScenario] = useState<'normal' | 'empty'>('normal');
  const [scope, setScope] = useState<'folder' | 'global'>('folder');
  const api = useMemo(() => createReviewApi('normal',{emptyCards:scenario === 'empty',manyCompleted:scenario === 'normal'}), [scenario]);
  const folderId = scope === 'folder' ? initialCards[0].folderId : undefined;
  const cardDisplay = useCardDisplay(folderId);
  const [selected, setSelected] = useState('');
  return <View style={{ flex:1,gap: t.uiSpacing.md }}>
    <SettingsSegmentedControl<'normal' | 'empty'> id="board-connected-scenario" value={scenario} onChange={value => {
      useCardStore.setState({ rows: {}, details: {} });
      setSelected('');
      setScenario(value);
    }}
      options={[{ value: 'normal', label: '카드 있음' }, { value: 'empty', label: '빈 보드' }]} />
    <SettingsSegmentedControl<'folder' | 'global'> id="board-connected-scope" value={scope} onChange={setScope}
      options={[{ value: 'folder', label: '현재 폴더' }, { value: 'global', label: '전체' }]} />
    <View testID="review-board-connected-frame" style={{flex:1}}>
      <CardBoardWorkspace key={`${scope}:${scenario}`} api={api} folderId={folderId}
        cardDisplay={cardDisplay} onOpen={setSelected} />
    </View>
    <Text accessibilityLabel="검수 화면 폭" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>
      {width < 600 ? 'phone 폭' : 'tablet 가로 폭'}
    </Text>
    {selected ? <Text testID="review-board-connected-selection" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>선택한 카드: {selected}</Text> : null}
  </View>;
}
