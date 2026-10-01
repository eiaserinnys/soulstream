import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';

/**
 * 메인 split과 absolute overlay가 공유하는 iPad top safe-area + floating inset 정본.
 * 하단 패널 가장자리는 outerInset에 고정하고, 조작부만 남은 safe-area를 내부에서 흡수한다.
 */
export function TabletSafeAreaFrame({
  children,
  topInset,
}: {
  children: React.ReactNode;
  topInset?: number;
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="tablet-safe-area-frame"
      style={[
        styles.frame,
        {
          marginTop: topInset ?? insets.top,
          paddingTop: t.tabletShell.outerInset,
          paddingBottom: t.tabletShell.outerInset,
          paddingHorizontal: t.tabletShell.outerInset,
        },
      ]}
    >
      <View testID="tablet-safe-area-content" style={styles.content}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  content: { flex: 1 },
});
