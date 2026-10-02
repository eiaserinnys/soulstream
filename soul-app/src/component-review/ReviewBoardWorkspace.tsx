import React, { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useTokens } from '../theme';
import { createReviewApi, initialCards } from './fixtures';
import { useCardDisplay } from '../hooks/useCardDisplay';

/** Real board inventory/rendering with a local API; no production transport. */
export function ReviewBoardWorkspace() {
  const t = useTokens();
  const { height } = useWindowDimensions();
  const api = useMemo(() => createReviewApi('normal',{manyCompleted:true}), []);
  const [scope, setScope] = useState<'folder' | 'global'>('folder');
  const folderId = scope === 'folder' ? initialCards[0].folderId : undefined;
  const cardDisplay = useCardDisplay(folderId);
  const [selected, setSelected] = useState('');
  return <View style={{ flex:1,gap: t.uiSpacing.md }}>
    <SettingsSegmentedControl<'folder' | 'global'> id="board-connected-scope" value={scope} onChange={setScope}
      options={[{ value: 'folder', label: '현재 폴더' }, { value: 'global', label: '전체' }]} />
    <View testID="review-board-connected-frame" style={{flex:1}}>
      <CardBoardWorkspace key={scope} api={api} folderId={folderId}
        cardDisplay={cardDisplay} onOpen={setSelected} />
    </View>
    {selected ? <Text testID="review-board-connected-selection" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>선택한 카드: {selected}</Text> : null}
  </View>;
}
