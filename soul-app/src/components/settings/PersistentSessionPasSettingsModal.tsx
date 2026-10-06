import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PersistentSessionResource } from '../../api/persistentSessionEndpoints';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens, type DesignTokens } from '../../theme';
import { PersistentSessionEditor } from './PersistentSessionViews';
import { PersistentSessionMonitoring } from './PersistentSessionMonitoring';
import { SettingsSegmentedControl } from './SettingsSegmentedControl';

const SECTIONS = [
  { value: 'account-model', label: '계정과 모델' },
  { value: 'display', label: '표시와 모션' },
  { value: 'history', label: '기록' },
] as const;
type Section = typeof SECTIONS[number]['value'];
type ReadState = 'loading' | 'ready' | 'error';

export function PersistentSessionPasSettingsModal({ sessionId, nodeId, onClose }: {
  sessionId: string;
  nodeId: string;
  onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const editorScroll = useRef<ScrollView>(null);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const [section, setSection] = useState<Section>('account-model');
  const [session, setSession] = useState<PersistentSessionResource | null>(null);
  const [sessionState, setSessionState] = useState<ReadState>(serverUrl ? 'loading' : 'error');
  const [presets, setPresets] = useState<ModelPresetAvailability[]>([]);
  const [dirty, setDirty] = useState(false);
  const onSessionChange = useCallback((value: PersistentSessionResource | null) => setSession(value), []);
  const onLoadStateChange = useCallback((value: ReadState) => setSessionState(value), []);
  const onPresetsChange = useCallback((value: ModelPresetAvailability[]) => setPresets(value), []);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
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
    <View testID="persistent-session-pas-settings-modal" style={styles.root}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>영구 세션</Text>
        <GlassButton
          testID="persistent-session-pas-close"
          accessibilityRole="button"
          accessibilityLabel="설정 닫기"
          onPress={requestClose}
          style={styles.close}
        >
          <Text style={styles.closeText}>닫기</Text>
        </GlassButton>
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
          <ScrollView ref={editorScroll} testID="persistent-session-pas-settings-scroll" style={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <PersistentSessionEditor
              mode="pas"
              serverUrl={serverUrl}
              sessionId={sessionId}
              nodeIdOverride={nodeId}
              onRevealError={revealEditorError}
              section={section === 'display' ? 'display' : 'account-model'}
              onDone={() => undefined}
              onSessionChange={onSessionChange}
              onLoadStateChange={onLoadStateChange}
              onPresetsChange={onPresetsChange}
              onDirtyChange={onDirtyChange}
            />
          </ScrollView>
        </View>
        <View style={[styles.pane, section !== 'history' && styles.hidden]}>
          <ScrollView testID="persistent-session-pas-monitoring-scroll" style={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <PersistentSessionMonitoring
              serverUrl={serverUrl}
              sessionId={sessionId}
              session={session}
              sessionState={sessionState}
              presets={presets}
            />
          </ScrollView>
        </View>
      </View>
    </View>
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
    close: { paddingHorizontal: t.spacing.xs },
    closeText: { ...t.foundation.typography.body, color: t.colors.accent, fontWeight: '600' },
    selector: { paddingHorizontal: t.foundation.pageInset, paddingBottom: t.spacing.sm },
    body: { flex: 1, minHeight: 0 },
    pane: { flex: 1, minHeight: 0 },
    hidden: { display: 'none' },
    scroll: { flex: 1 },
  });
}
