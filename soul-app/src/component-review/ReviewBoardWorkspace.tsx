import React, { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { CardBoardWorkspace } from '../components/planner/CardBoardWorkspace';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useTokens } from '../theme';
import { createReviewApi, initialCards } from './fixtures';

/** Real board inventory/rendering with a local API; no production transport. */
export function ReviewBoardWorkspace() {
  const t = useTokens();
  const { height } = useWindowDimensions();
  const api = useMemo(() => createReviewApi(), []);
  const [scope, setScope] = useState<'folder' | 'global'>('folder');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [selected, setSelected] = useState('');
  return <View style={{ gap: t.uiSpacing.md }}>
    <SettingsSegmentedControl<'folder' | 'global'> id="board-connected-scope" value={scope} onChange={setScope}
      options={[{ value: 'folder', label: '현재 폴더' }, { value: 'global', label: '전체' }]} />
    <View testID="review-board-connected-frame" style={{ height: height - t.hitTarget.min * 2 }}>
      <CardBoardWorkspace api={api} folderId={scope === 'folder' ? initialCards[0].folderId : undefined}
        cardDisplay={{ includeCompleted, onChange: setIncludeCompleted }} onOpen={setSelected} />
    </View>
    {selected ? <Text testID="review-board-connected-selection" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>선택한 카드: {selected}</Text> : null}
  </View>;
}
