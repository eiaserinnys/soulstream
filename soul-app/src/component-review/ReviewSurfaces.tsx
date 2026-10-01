import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { GlassButton, GlassSurface } from '../components/GlassSurface';
import { AppGlassCard } from '../components/AppGlassCard';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { ReviewSection } from './ReviewSection';

export function ReviewSurfaces() {
  const t = useTokens();
  const [count, setCount] = useState(0);
  const label = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  return <>
    <ReviewSection title="실제 유리 표면 · 웹 대체 표현">
      {(['glassSoft', 'glassDense', 'nativeSheet'] as const).map((role) => <GlassSurface
        key={role} role={role} testID={'review-surface-' + role} style={{ padding: t.cardLayout.padding }}>
        <Text style={label}>{role} 표면의 현재 표현입니다.</Text>
      </GlassSurface>)}
      <AppGlassCard style={{ padding: t.cardLayout.padding }}>
        <Text style={label}>AppGlassCard를 사용하는 카드 표면입니다.</Text>
      </AppGlassCard>
    </ReviewSection>
    <ReviewSection title="실제 버튼 · 기본·주요·아이콘·비활성">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm, alignItems: 'center' }}>
        <GlassButton accessibilityLabel="예시 보조 동작" onPress={() => setCount((v) => v + 1)}><Text style={label}>보조 동작</Text></GlassButton>
        <GlassButton variant="primary" accessibilityLabel="예시 주요 동작" onPress={() => setCount((v) => v + 1)}>
          <Text style={{ ...label, color: t.colors.accentText }}>주요 동작</Text>
        </GlassButton>
        <LiquidGlassButton iconOnly accessibilityLabel="예시 아이콘 동작" onPress={() => setCount((v) => v + 1)}>
          <Ionicons name="add" size={t.iconSize.standard} color={t.colors.textPrimary} />
        </LiquidGlassButton>
        <GlassButton disabled onPress={() => setCount((v) => v + 1)}><Text style={label}>비활성</Text></GlassButton>
      </View>
      <Text testID="review-button-count" style={label}>로컬 버튼 동작: {count}</Text>
    </ReviewSection>
  </>;
}
