import React, { useMemo } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  View,
  type StyleProp,
  type TouchableOpacityProps,
  type ViewStyle,
} from 'react-native';
import { createPrimitiveRoles, useTokens, type DesignTokens } from '../theme';

export interface CompactTouchTargetProps
  extends Omit<TouchableOpacityProps, 'style'> {
  frameStyle?: StyleProp<ViewStyle>;
  surfaceStyle?: StyleProp<ViewStyle>;
  surfaceTestID?: string;
}

/**
 * 44/48pt 실제 hit frame 안에 compact 시각 surface를 분리해 배치한다.
 * hitSlop은 부모 경계를 넘지 못하므로 접근성 계약의 정본으로 사용하지 않는다.
 */
export function CompactTouchTarget({
  children,
  frameStyle,
  surfaceStyle,
  surfaceTestID,
  ...touchableProps
}: CompactTouchTargetProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <TouchableOpacity
      {...touchableProps}
      style={[frameStyle, styles.frame]}
    >
      <View testID={surfaceTestID} style={[styles.surface, surfaceStyle]}>
        {children}
      </View>
    </TouchableOpacity>
  );
}

function makeStyles(t: DesignTokens) {
  const primitive = createPrimitiveRoles(t).iconFrame;
  return StyleSheet.create({
    frame: {
      minWidth: Math.max(t.hitTarget.min, primitive.minHeight),
      minHeight: Math.max(t.hitTarget.min, primitive.minHeight),
      alignItems: 'center',
      justifyContent: 'center',
    },
    surface: {
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
