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
  shown = true,
}: {
  label: string;
  width: number;
  height: number;
  motionEnabled: boolean;
  shown?: boolean;
}) {
  const t = useTokens();
  return <View style={{ alignItems: 'center', gap: t.spacing.sm }}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
    <SwayCharacter width={width} height={height} shown={shown} motionEnabled={motionEnabled} active />
  </View>;
}

export function ReviewPersistent() {
  const t = useTokens();
  return <ReviewSection title="영구 세션 · 캐릭터 부품">
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.spacing.xl, paddingHorizontal: t.spacing.xl }}>
      <CharacterSample label="가로 iPad · 움직임 켬" width={152} height={228} motionEnabled />
      <CharacterSample label="세로 iPad · 움직임 켬" width={126} height={189} motionEnabled />
      <CharacterSample label="움직임 끔" width={152} height={228} motionEnabled={false} />
      <CharacterSample label="표시 끔" width={152} height={228} motionEnabled shown={false} />
    </View>
  </ReviewSection>;
}
