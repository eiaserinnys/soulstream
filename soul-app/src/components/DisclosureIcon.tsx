import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTokens } from '../theme';

export type DisclosureIconTone = 'secondary' | 'tertiary' | 'disabled' | 'accent';

interface DisclosureIconProps {
  expanded: boolean;
  color?: string;
  size?: number;
  tone?: DisclosureIconTone;
}

/** 펼치기/접기 방향의 단일 정본: 펼친 상태는 위, 접힌 상태는 아래. */
export function DisclosureIcon({
  expanded,
  color,
  size,
  tone = 'tertiary',
}: DisclosureIconProps) {
  if (color !== undefined && size !== undefined) {
    return <DisclosureGlyph expanded={expanded} color={color} size={size} />;
  }
  return (
    <SemanticDisclosureIcon
      expanded={expanded}
      color={color}
      size={size}
      tone={tone}
    />
  );
}

function SemanticDisclosureIcon({
  expanded,
  color,
  size,
  tone,
}: DisclosureIconProps & { tone: DisclosureIconTone }) {
  const t = useTokens();
  const resolvedColor = color ?? {
    secondary: t.colors.textSecondary,
    tertiary: t.colors.textTertiary,
    disabled: t.colors.textDisabled,
    accent: t.colors.accent,
  }[tone];
  const resolvedSize = size ?? t.iconSize.compact;
  return <DisclosureGlyph expanded={expanded} color={resolvedColor} size={resolvedSize} />;
}

function DisclosureGlyph({
  expanded,
  color,
  size,
}: {
  expanded: boolean;
  color: string;
  size: number;
}) {
  return (
    <Ionicons
      name={expanded ? 'chevron-up' : 'chevron-down'}
      size={size}
      color={color}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
    </Ionicons>
  );
}
