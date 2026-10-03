import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { safeErrorDetail } from '../../../../packages/soul-ui/src/lib/safe-error-detail';
import { useTokens } from '../../theme';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { makeStyles } from './SessionSuccessionSheet.styles';

/** Receives only already sanitized detail; raw errors never enter the render tree. */
export function SheetErrorNotice({ summary, detail }: { summary: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]);
  return <GroupedGlassSheet><View style={styles.formField}>
    <Text accessibilityRole="alert" style={styles.purpose}>{summary}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="기술 상세" accessibilityState={{ expanded }}
      style={styles.headerButton} onPress={() => setExpanded(current => !current)}>
      <Text style={styles.headerAction}>기술 상세 {expanded ? '−' : '+'}</Text>
    </TouchableOpacity>
    {expanded ? <Text selectable style={styles.purpose}>{detail}</Text> : null}
  </View></GroupedGlassSheet>;
}

export function sheetErrorDetail(cause: unknown): string {
  return safeErrorDetail(cause instanceof Error ? cause.message : String(cause));
}
