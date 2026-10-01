import React from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { PostItCard } from '../components/planner/PostItCard';
import { makeCard } from './fixtures';

export function ReviewPostIt() {
  const t = useTokens();
  return <View testID="postit-size-comparison" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.xl }}>
    {(['full', 'compact'] as const).flatMap((variant) => (['report', 'instruction'] as const).flatMap((kind) => (['short', 'long'] as const).map((title) => {
      const key = `${variant}-${kind}-${title}`;
      const card = { ...makeCard('review'), title: title === 'short' ? '짧은 제목' : '같은 긴 제목으로 두 줄 자연 높이와 말줄임을 확인하는 카드',
        latestActivity: { kind, format: 'markdown' as const,
          body: '같은 본문입니다. 첫 줄 칩 뒤로 본문이 이어지고 다음 줄은 전체 폭을 씁니다. 남는 영역만큼 더 읽고 footer는 제자리에 둡니다.\n둘째 문단도 같은 글자 크기로 표시합니다.', createdAt: '' } };
      return <View key={key} testID={`postit-comparison-${key}`} style={{ gap: t.uiSpacing.sm }}>
        <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{variant} · {kind === 'report' ? '보고' : '지시'} · {title === 'short' ? '한 줄' : '두 줄'}</Text>
        <PostItCard api={null} card={card} variant={variant} onOpen={() => {}} />
      </View>;
    })))}
  </View>;
}
