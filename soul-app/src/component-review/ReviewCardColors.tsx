import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { CardStatusMenu } from '../components/planner/CardStatusMenu';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { CARD_COLORS } from '../../../packages/wire-schema/src/card_colors';
import { useTokens } from '../theme';
import { createCardColorReviewClient, type CardColorReviewMode } from './fixture-client';
import { ReviewSection } from './ReviewSection';

const states: Array<{ value: CardColorReviewMode; label: string }> = [
  { value: 'success', label: '저장 가능' },
  { value: 'pending', label: '저장 중' },
  { value: 'error', label: '저장 오류' },
];

export function ReviewCardColors() {
  const t = useTokens();
  const [mode, setMode] = useState<CardColorReviewMode>('success');
  const [opened, setOpened] = useState(false);
  const client = useMemo(() => createCardColorReviewClient(mode), [mode]);
  const body = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  return <View style={{ flex: 1, padding: t.uiSpacing.sm, gap: t.spacing.md, backgroundColor: t.colors.background }}>
    <ReviewSection title="카드 색상 선택">
      <Text style={body}>실제 상태 메뉴와 색 선택 행을 공개 예시 카드로 확인합니다. 저장 결과는 검수 화면 메모리에만 남습니다.</Text>
      <SettingsSegmentedControl<CardColorReviewMode> id="review-card-color-state" value={mode} onChange={value => {
        setOpened(false);
        setMode(value);
      }} options={states} wrap />
      <Text testID="review-card-color-current" style={body}>현재 저장 색상: {CARD_COLORS[client.card.color ?? 'yellow'].name}</Text>
      <GlassButton accessibilityLabel="카드 색상 메뉴 열기" onPress={() => setOpened(true)}>
        <Text style={body}>색상 메뉴 열기</Text>
      </GlassButton>
    </ReviewSection>
    {opened ? <CardStatusMenu api={client.api} card={client.card} onClose={() => setOpened(false)} /> : null}
  </View>;
}
