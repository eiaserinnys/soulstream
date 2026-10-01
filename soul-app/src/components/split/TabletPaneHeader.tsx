import React, { useMemo } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

/**
 * iPad split shell과 업무 overlay가 공유하는 첫 chrome 행.
 *
 * 최소 높이만 고정해 Dynamic Type이나 여러 줄 제목은 필요한 만큼 확장한다.
 */
export function TabletPaneHeader({ style, ...props }: ViewProps) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return <View {...props} style={[styles.header, style]} />;
}

function makeStyles(t: DesignTokens) {
  const header = t.tabletShell.header;
  return StyleSheet.create({
    header: {
      minHeight: header.minHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: header.paddingHorizontal,
      paddingVertical: header.paddingVertical,
    },
  });
}
