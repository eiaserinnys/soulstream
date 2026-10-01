import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { SessionCardView } from '../components/SessionCardView';
import { CardRow } from '../components/planner/CardRow';
import { useCardStore } from '../store/cardStore';
import { createReviewApi, initialCards, sessions } from './fixtures';
import { ReviewSection } from './ReviewSection';

export function ReviewRows() {
  const t = useTokens();
  const api = useMemo(() => createReviewApi(), []);
  const updates = useCardStore((s) => s.rows);
  const [reviewed, setReviewed] = useState(false);
  const [selected, setSelected] = useState('');
  return <>
    <ReviewSection title="카드 행 · 모든 상태">
      <View testID="review-card-rows" style={{ gap: t.spacing.sm }}>
        {initialCards.map((initial) => {
          const card = updates[initial.id] ?? initial;
          return <CardRow key={card.id} card={card} api={api} today onOpen={() => setSelected(card.title)} />;
        })}
      </View>
    </ReviewSection>
    <ReviewSection title="세션 행 · 실행·검수·대기·오류·응답 필요">
      <View testID="review-session-rows" style={{ gap: t.spacing.sm }}>
        {sessions.map((session) => <SessionCardView key={session.agentSessionId}
          session={session.agentSessionId === 'public-review' && reviewed ? { ...session, reviewState: 'acknowledged' } : session}
          folderName="공개 예시 프로젝트" serverUrl="" jwt={null}
          review={{ inFlight: false, acknowledge: async () => setReviewed(true) }}
          onPress={() => setSelected(session.displayName ?? '')} />)}
        <SessionCardView session={sessions[0]} small embedded folderName="공개 예시 프로젝트" serverUrl="" jwt={null}
          review={{ inFlight: false, acknowledge: async () => {} }} onPress={() => setSelected('작은 내장 세션 행')} />
      </View>
    </ReviewSection>
    {selected ? <Text testID="review-row-selection" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>
      선택한 행: {selected}
    </Text> : null}
  </>;
}
