import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens, type DesignTokens } from '../../theme';
import { PersistentSessionEditor, PersistentSessionInstructions } from './PersistentSessionViews';
import { PersistentSessionMonitoring } from './PersistentSessionMonitoring';
import { settingsPanelPage } from './SettingsFormParts';
import { SettingsSegmentedControl } from './SettingsSegmentedControl';

const SECTIONS = [
  { value: 'account-model', label: '계정과 모델' },
  { value: 'display', label: '표시와 모션' },
  { value: 'history', label: '기록' },
] as const;
type Section = typeof SECTIONS[number]['value'];

export function PersistentSessionPasSettingsModal({ sessionId, nodeId, onClose }: {
  sessionId: string;
  nodeId: string;
  onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const editorScroll = useRef<ScrollView>(null);
  const savePasRef = useRef<() => void>(() => undefined);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const [section, setSection] = useState<Section>('account-model');
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState({ disabled: true, busy: false });
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const onPasSaveActionChange = useCallback((save: () => void, disabled: boolean, busy: boolean) => {
    savePasRef.current = save;
    setSaveStatus((current) => current.disabled === disabled && current.busy === busy ? current : { disabled, busy });
  }, []);
  const revealEditorError = useCallback(() => editorScroll.current?.scrollTo({ y: 0, animated: true }), []);
  const requestClose = useCallback(() => {
    if (!dirty) { onClose(); return; }
    Alert.alert('저장하지 않은 변경', '계정과 모델의 변경을 저장하지 않고 닫을까요?', [
      { text: '계속 편집', style: 'cancel' },
      { text: '버리기', style: 'destructive', onPress: onClose },
    ]);
  }, [dirty, onClose]);

  return <AppModalSurface
    visible
    variant="expanded"
    modalId="modal_settings"
    animationType="fade"
    presentationStyle="pageSheet"
    onRequestClose={requestClose}
    surfaceTestID="persistent-session-pas-settings-surface"
    safeAreaTestID="persistent-session-pas-settings-safe-area"
  >
    <AppKeyboardAvoidingView
      testID="persistent-session-pas-settings-modal"
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>영구 세션</Text>
        <TouchableOpacity
          testID="persistent-session-pas-close"
          accessibilityRole="button"
          accessibilityLabel="설정 닫기"
          onPress={requestClose}
          style={styles.headerAction}
        >
          <Text style={styles.actionText}>닫기</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.selector}>
        <SettingsSegmentedControl<Section>
          id="pas-settings"
          value={section}
          options={SECTIONS}
          onChange={setSection}
        />
      </View>
      <View style={styles.body}>
        <View style={[styles.pane, section === 'history' && styles.hidden]}>
          <ScrollView ref={editorScroll} testID="persistent-session-pas-settings-scroll" {...settingsPanelPage(t, false)} showsVerticalScrollIndicator={false}>
            <PersistentSessionEditor
              mode="pas"
              serverUrl={serverUrl}
              sessionId={sessionId}
              nodeIdOverride={nodeId}
              onRevealError={revealEditorError}
              section={section === 'display' ? 'display' : 'account-model'}
              onDone={() => undefined}
              onDirtyChange={onDirtyChange}
              onPasSaveActionChange={onPasSaveActionChange}
            />
          </ScrollView>
        </View>
        <View style={[styles.pane, section !== 'history' && styles.hidden]}>
          <ScrollView testID="persistent-session-pas-monitoring-scroll" {...settingsPanelPage(t, false)} showsVerticalScrollIndicator={false}>
            <PersistentSessionInstructions serverUrl={serverUrl} sessionId={sessionId} />
            <PersistentSessionMonitoring
              serverUrl={serverUrl}
              sessionId={sessionId}
            />
          </ScrollView>
        </View>
      </View>
      {section === 'account-model' ? <View testID="persistent-session-pas-settings-footer" style={styles.footer}>
        <GlassButton
          variant="primary"
          testID="persistent-pas-settings-save"
          accessibilityLabel="저장"
          disabled={saveStatus.disabled}
          onPress={() => savePasRef.current()}
          style={styles.footerAction}
        >
          <Text style={styles.primaryText}>{saveStatus.busy ? '저장 중…' : '저장'}</Text>
        </GlassButton>
      </View> : null}
    </AppKeyboardAvoidingView>
  </AppModalSurface>;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      paddingHorizontal: t.foundation.pageInset,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    title: { flex: 1, ...t.foundation.typography.navigation, color: t.colors.textPrimary },
    headerAction: { minHeight: t.hitTarget.min, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs },
    actionText: { ...t.foundation.typography.body, color: t.colors.accent, fontWeight: '600' },
    primaryText: { ...t.foundation.typography.body, color: t.colors.accentText, fontWeight: '700' },
    selector: { paddingHorizontal: t.foundation.pageInset, paddingBottom: t.spacing.sm },
    body: { flex: 1, minHeight: 0 },
    pane: { flex: 1, minHeight: 0 },
    hidden: { display: 'none' },
    footer: { flexDirection: 'row', gap: t.spacing.sm, paddingHorizontal: t.foundation.pageInset, paddingVertical: t.cardLayout.padding, paddingBottom: t.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
    footerAction: { flexGrow: 1 },
  });
}
