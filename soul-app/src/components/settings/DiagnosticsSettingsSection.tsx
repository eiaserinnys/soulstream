import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import { UsageWidgetBridgeDiagnosticsRow } from '../../widgets/UsageWidgetBridgeDiagnosticsRow';
import { SessionDiagnosticsSection } from './SessionDiagnosticsSection';
import { SettingsDivider, SettingsSection } from './SettingsSection';

export function DiagnosticsSettingsSection({
  flattened,
}: {
  flattened: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <SettingsSection id="diagnostics" title="진단" flattened={flattened}>
      <View style={styles.block}>
        <UsageWidgetBridgeDiagnosticsRow />
      </View>
      <SettingsDivider />
      <View style={styles.block}>
        <SessionDiagnosticsSection flattened />
      </View>
    </SettingsSection>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { padding: t.cardLayout.padding },
  });
}
