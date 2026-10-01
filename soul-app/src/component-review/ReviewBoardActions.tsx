import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { CardRow } from '../components/planner/CardRow';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { makeCard } from './fixtures';

export function ReviewBoardActions() {
  const t = useTokens();
  const [pane, setPane] = useState<'wide' | 'narrow'>('wide');
  const width = t.tabletShell.folderPane[pane === 'wide' ? 'maxWidth' : 'minWidth'];
  return <View style={{ gap: t.uiSpacing.md }}>
    <SettingsSegmentedControl<'wide' | 'narrow'> id="board-action-width" value={pane} onChange={setPane}
      options={[{ value: 'wide', label: '보드 열' }, { value: 'narrow', label: '좁은 iPad pane' }]} />
    <View testID="board-action-comparison" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.cardLayout.gap }}>
      {(['running', 'review'] as const).map((status) => <View key={status} style={{ width, gap: t.uiSpacing.sm }}>
        <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{status === 'review' ? '완료 버튼 있음' : '완료 버튼 없음'}</Text>
        <CardRow api={null} board onOpen={() => {}} card={{ ...makeCard(status), id: `compare-${status}`,
          title: '같은 긴 제목과 본문으로 보조정보 액션 배치를 확인하는 카드',
          request: '같은 본문입니다. 버튼 유무에 따라 본문 시작과 카드 높이가 달라지지 않습니다.',
          latestActivity: { kind: 'instruction', format: 'markdown', body: '같은 최신 지시입니다.', createdAt: '2026-10-01' } }} />
      </View>)}
    </View>
  </View>;
}
