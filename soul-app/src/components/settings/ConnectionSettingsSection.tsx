import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ServerType } from '../../store/settingsStore';
import { useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { SettingsDivider, SettingsSection } from './SettingsSection';
import { SettingsSegmentedControl } from './SettingsSegmentedControl';

const SERVER_OPTIONS = [
  { value: 'soul-server', label: '소울 서버' },
  { value: 'orchestrator', label: '오케스트레이터' },
] as const;

export function ConnectionSettingsSection({
  flattened,
  url,
  serverType,
  testing,
  result,
  onUrlChange,
  onServerTypeChange,
  onTest,
  onSave,
  savedUrl, savedType, saved, hideSave, runtimeMode = null,
}: {
  flattened: boolean;
  url: string;
  serverType: ServerType;
  testing: boolean;
  result: { ok: boolean; msg: string } | null;
  onUrlChange(value: string): void;
  onServerTypeChange(value: ServerType): void;
  onTest(): void;
  onSave(): void;
  runtimeMode?: 'single' | 'orchestrator' | null;
  savedUrl?: string; savedType?: ServerType; saved?: boolean; hideSave?: boolean;
}) {
  const t = useTokens();
  const [focused, setFocused] = useState(false);
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <SettingsSection id="connection" title="연결" flattened={flattened}>
      {savedUrl !== undefined ? <View style={styles.block}><Text style={styles.rowLabel}>현재 연결</Text><Text style={styles.result}>{savedUrl || '저장된 연결 없음'}</Text><Text style={styles.result}>저장 유형: {SERVER_OPTIONS.find(option => option.value === savedType)?.label ?? '미확인'}</Text><Text style={styles.result}>확인된 실행 모드: {runtimeMode === 'orchestrator' ? '오케스트레이터' : runtimeMode === 'single' ? '단일 서버' : '미확인'}</Text>{saved ? <Text style={styles.ok}>이 기기에 연결 설정을 저장했습니다.</Text> : null}</View> : null}
      <View style={styles.block}>
        <Text style={styles.rowLabel}>서버 URL</Text>
        <TextInput
          testID="settings-server-input"
          accessibilityLabel="서버 URL"
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          style={[styles.input, focused && { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint }]}
          value={url}
          onChangeText={onUrlChange}
          placeholder="http://192.168.0.1:8080"
          placeholderTextColor={t.colors.textPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {savedUrl !== undefined && url.trim() !== savedUrl ? <Text style={styles.rowLabel}>연결을 저장하면 현재 로그인이 초기화됩니다. 새 서버에 다시 로그인해 주세요.</Text> : null}
      </View>
      <SettingsDivider />
      <View style={styles.block}>
        <Text style={styles.rowLabel}>서버 유형</Text>
        <Text style={styles.rowLabel}>서버 유형은 저장 분류이며 서버 실행 모드를 바꾸지 않습니다.</Text>
        <SettingsSegmentedControl
          id="server"
          value={serverType}
          options={SERVER_OPTIONS}
          onChange={onServerTypeChange}
        />
      </View>
      <SettingsDivider />
      <View style={styles.block}>
        {result ? (
          <View style={styles.resultRow}>
            <Text style={[styles.resultIcon, result.ok ? styles.ok : styles.fail]}>
              {result.ok ? '✓' : '!'}
            </Text>
            <Text
              accessibilityRole={result.ok ? 'text' : 'alert'}
              style={[styles.result, result.ok ? styles.ok : styles.fail]}
            >
              {result.msg}
            </Text>
          </View>
        ) : null}
        <View style={styles.actionRow}>
          <GlassButton
            testID="settings-test-connection"
            surfaceTestID="settings-test-connection-surface"
            accessibilityLabel="연결 확인"
            style={styles.action}
            contentStyle={styles.secondaryButtonContent}
            onPress={onTest}
            disabled={testing || !url.trim()}
          >
            {testing ? (
              <ActivityIndicator size="small" color={t.colors.accent} />
            ) : (
              <Text style={styles.secondaryText}>연결 확인</Text>
            )}
          </GlassButton>
          {!hideSave ? <GlassButton
            variant="primary"
            testID="settings-save"
            surfaceTestID="settings-save-surface"
            accessibilityLabel="연결 저장"
            style={styles.action}
            onPress={onSave}
            disabled={!url.trim()}
          >
            <Text style={styles.primaryText}>연결 저장</Text>
          </GlassButton> : null}
        </View>
      </View>
    </SettingsSection>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { padding: t.cardLayout.padding, gap: t.spacing.md },
    rowLabel: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
    },
    input: {
      ...t.foundation.typography.body,
      color: t.colors.textPrimary,
      minHeight: t.foundation.minHeight.field,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      borderRadius: t.foundation.radius.field,
      backgroundColor: t.colors.surfaceMuted,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.sm,
    },
    resultIcon: { ...t.foundation.typography.body, fontWeight: '800' },
    result: { ...t.foundation.typography.body, flex: 1 },
    ok: { color: t.colors.successText },
    fail: { color: t.colors.errorText },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
    action: { flex: 1, minWidth: 140 },
    secondaryButtonContent: { minHeight: t.foundation.minHeight.secondary },
    secondaryText: {
      ...t.foundation.typography.body,
      color: t.colors.link,
      fontWeight: '600',
    },
    primaryText: {
      ...t.foundation.typography.body,
      color: t.colors.accentText,
      fontWeight: '700',
    },
  });
}
