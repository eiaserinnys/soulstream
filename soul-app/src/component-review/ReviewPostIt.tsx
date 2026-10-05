import React from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { CardRow } from '../components/planner/CardRow';
import { PostItCard } from '../components/planner/PostItCard';
import type { CardCheckItem } from '../api/cardTypes';
import { makeCard } from './fixtures';
import { CARD_COLOR_KEYS, CARD_COLORS } from '../../../packages/wire-schema/src/card_colors';

export function ReviewPostIt() {
  const t = useTokens();
  return <View style={{ gap: t.uiSpacing.xl }}>
    <View testID="postit-size-comparison" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.xl }}>
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
    </View>
    <View testID="postit-checks-comparison" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.xl }}>
      {(['full', 'compact'] as const).map(variant => {
        const card = { ...makeCard('review'), id: `review-checks-${variant}`, title: '확인할 결과가 있는 긴 제목의 카드',
          now: { text: '같은 상황판과 상태를 목록에서 봅니다.', turn: 'user' as const, ask: '확인 항목과 결과 캡처를 살펴봐 주세요.', updatedAt: '', sessionId: 'public-agent' },
          items: [{ id: 1, display: 'reported' }, { id: 2, display: 'changed' }, { id: 3, display: 'confirmed' }, { id: 4, display: 'confirmed' }, { id: 5, display: 'confirmed' }] as CardCheckItem[] };
        return <View key={variant} testID={`card-checks-${variant}-surfaces`} style={{ gap: t.uiSpacing.lg, width: '100%' }}>
          <PostItCard api={null} card={card} variant={variant} onOpen={() => {}} />
          {variant === 'full' ? <><CardRow api={null} card={card} onOpen={() => {}} /><CardRow api={null} card={card} board onOpen={() => {}} /></> : null}
        </View>;
      })}
    </View>
    <View testID="postit-color-review" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.xl }}>
      {CARD_COLOR_KEYS.map(color => {
        const card = { ...makeCard('todo'), id: `review-postit-color-${color}`, title: `${CARD_COLORS[color].name} 카드`, color };
        return <View key={color} style={{ gap: t.uiSpacing.sm }}>
          <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{CARD_COLORS[color].name}</Text>
          <PostItCard api={null} card={card} onOpen={() => {}} />
        </View>;
      })}
    </View>
  </View>;
}
