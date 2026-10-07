import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { TurnEndCaptions } from '../components/chat/TurnEndCaptions';
import type { TurnSummaryRenderItem } from '../components/chat/groupChatEvents';
import { useTokens } from '../theme';

const usage = {
  title: '컨텍스트 약 63.0% · 정가 $0.62',
  expandedTitle: '컨텍스트 약 630,000 / 1,000,000 (63.0%)',
  lines: ['턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)'],
};

const summary: TurnSummaryRenderItem = {
  kind: 'turn-summary',
  event: {
    id: '940',
    type: 'turn_summary',
    data: { content: '관련 파일을 확인하고 필요한 수정과 검증을 마쳤습니다.', final_response_event_id: 939 },
  },
  content: '관련 파일을 확인하고 필요한 수정과 검증을 마쳤습니다.',
  anchorEventId: 939,
  key: 'turn-summary-940',
};

const longSummary: TurnSummaryRenderItem = {
  ...summary,
  event: {
    ...summary.event,
    id: '941',
    data: { content: '좁은 화면에서도 요약 본문이 캡션 영역 안에서 줄바꿈하고, 사용량 본문 다음 줄에 이어져 읽히는지 확인합니다.', final_response_event_id: 939 },
  },
  content: '좁은 화면에서도 요약 본문이 캡션 영역 안에서 줄바꿈하고, 사용량 본문 다음 줄에 이어져 읽히는지 확인합니다.',
  key: 'turn-summary-941',
};

export function ReviewTurnEndCaptions() {
  const t = useTokens();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const variant = query.get('variant') ?? 'both';
  const [lateSummary, setLateSummary] = useState(false);

  useEffect(() => {
    if (variant !== 'late') return undefined;
    const timeout = setTimeout(() => setLateSummary(true), 900);
    return () => clearTimeout(timeout);
  }, [variant]);

  const withUsage = variant !== 'summary-only';
  const withSummary = variant === 'summary-only' || variant === 'both' || variant === 'long' || variant === 'late';
  const selectedSummary = variant === 'long' ? longSummary : summary;

  return (
    <View testID="review-turn-end-captions" style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: t.colors.background }}>
      <TurnEndCaptions
        usage={withUsage ? (variant === 'long' ? {
          ...usage,
          title: '컨텍스트 약 98.6% · 정가 $12.45',
          expandedTitle: '컨텍스트 약 986,420 / 1,000,000 (98.6%)',
          lines: ['턴 완료 · 입력 986,420 (캐시 914,008) · 출력 42,618 · 정가 $12.45 (세션 $124.50)'],
        } : usage) : undefined}
        summaries={withSummary && (variant !== 'late' || lateSummary) ? [selectedSummary] : undefined}
      />
    </View>
  );
}
