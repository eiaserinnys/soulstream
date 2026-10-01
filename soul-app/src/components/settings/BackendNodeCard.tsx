import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';

export function BackendNodeCard({
  nodeId,
  defaultExpanded = true,
  children,
}: {
  nodeId: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View testID={`settings-backend-node-${nodeId}`} style={styles.container}>
      <TouchableOpacity
        testID={`settings-backend-node-${nodeId}-header`}
        accessibilityRole="button"
        accessibilityLabel={`노드 ${nodeId}`}
        accessibilityState={{ expanded }}
        style={styles.header}
        onPress={() => setExpanded((value) => !value)}
      >
        <View style={styles.headerCopy}>
          <Text style={styles.nodeId} numberOfLines={1}>
            노드: {nodeId}
          </Text>
        </View>
        <DisclosureIcon
          expanded={expanded}
          color={t.colors.textTertiary}
          size={t.iconSize.standard}
        />
      </TouchableOpacity>
      {expanded ? <View style={styles.providers}>{children}</View> : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { padding: t.cardLayout.padding },
    header: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
    },
    headerCopy: { flex: 1 },
    nodeId: {
      ...t.foundation.typography.mono,
      color: t.colors.textTertiary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    providers: {
      marginTop: t.spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
  });
}
