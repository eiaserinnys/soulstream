import React from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { PostItCard } from '../components/planner/PostItCard';
import { makeCard } from './fixtures';

export function ReviewPostIt() {
  const t = useTokens();
  const card = { ...makeCard('review'), title: '같은 긴 제목으로 원본과 축소 포스트잇을 확인하는 카드',
    latestActivity: { kind: 'report' as const, format: 'markdown' as const,
      body: '본문 크기를 유지하면서 보드에서 더 많은 열을 봅니다.\n마지막 보고의 라벨과 본문을 읽을 수 있습니다.\n상세에서 전체 원문을 확인합니다.\n같은 글자와 조작영역을 유지합니다.', createdAt: '' } };
  return <View testID="postit-size-comparison" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.xl }}>
    {(['full', 'compact'] as const).map((variant) => <View key={variant} testID={`postit-comparison-${variant}`} style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{variant === 'full' ? '기본 포스트잇' : '보드 compact'}</Text>
      <PostItCard api={null} card={card} variant={variant} onOpen={() => {}} />
    </View>)}
  </View>;
}
