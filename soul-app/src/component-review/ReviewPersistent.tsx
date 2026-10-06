import React from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { ReviewSection } from './ReviewSection';

function CharacterSample({
  label,
  width,
  height,
  motionEnabled,
  characterAlign = 'center',
  shown = true,
}: {
  label: string;
  width: number;
  height: number;
  motionEnabled: boolean;
  characterAlign?: 'center' | 'start';
  shown?: boolean;
}) {
  const t = useTokens();
  return <View style={{ alignItems: 'center', gap: t.spacing.sm }}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
    <View style={{ alignSelf: characterAlign === 'start' ? 'flex-start' : 'center' }}>
      <SwayCharacter width={width} height={height} shown={shown} motionEnabled={motionEnabled} active />
    </View>
  </View>;
}

export function ReviewPersistent() {
  const t = useTokens();
  return <View style={{ flex: 1, padding: t.cardLayout.padding }}>
    <ReviewSection title="영구 세션 · 캐릭터 부품">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.spacing.xl }}>
        <CharacterSample label="가로 iPad · 움직임 켬" width={152} height={228} motionEnabled />
        <CharacterSample label="세로 iPad · 움직임 켬" width={126} height={189} motionEnabled characterAlign="start" />
        <CharacterSample label="움직임 끔" width={152} height={228} motionEnabled={false} />
        <CharacterSample label="표시 끔" width={152} height={228} motionEnabled shown={false} />
      </View>
    </ReviewSection>
  </View>;
}
