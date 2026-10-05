import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { GlassButton } from '../components/GlassSurface';
import { SettingsCategorySidebar } from '../components/settings/SettingsCategorySidebar';
import { SETTINGS_CATEGORIES, type SettingsCategory } from '../components/settings/settingsCategories';
import { SettingsWorkspaceContext, confirmSettingsDiscard, type SettingsSaveScope, type SettingsJobDestination, type SettingsPersistentDestination } from '../components/settings/SettingsWorkspaceContext';
import { useDashboardAdminStatus } from '../components/settings/useDashboardAdminStatus';
import { TABLET_BREAKPOINT, useTokens, type DesignTokens } from '../theme';
import { SettingsContent } from './SettingsContent';

interface Props {
  extraBottomPadding?: number;
  bottomSafeAreaOwner?: 'screen' | 'parent';
  showTitle?: boolean;
  flattened?: boolean;
  category?: SettingsCategory;
  preserveSections?: boolean;
  showAdmin?: boolean;
  onOpenRecurringJobs?: () => void;
  onClose?: () => void;
  connectionOnly?: boolean;
  registerCloseRequest?: (close: () => void) => void;
}

/** All three entry points share this stable host and the production form controllers. */
export function SettingsScreen({ extraBottomPadding = 0, bottomSafeAreaOwner = 'screen', flattened = false, category: initialCategory, showAdmin, onClose, connectionOnly = false, registerCloseRequest }: Props = {}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const window = useWindowDimensions();
  const [width, setWidth] = useState(window.width);
  const wide = !connectionOnly && width >= TABLET_BREAKPOINT;
  const detectedAdmin = useDashboardAdminStatus(showAdmin === undefined);
  const isAdmin = showAdmin ?? detectedAdmin;
  const [category, setCategory] = useState<SettingsCategory | null>(connectionOnly ? 'connection' : initialCategory ?? null);
  const [jobs, setJobs] = useState<SettingsJobDestination>({ kind: 'list' });
  const [persistent, setPersistent] = useState<SettingsPersistentDestination>({ kind: 'list' });
  const [scopes, setScopes] = useState<Partial<Record<SettingsCategory, SettingsSaveScope>>>({});
  const register = useCallback((id: SettingsCategory, scope: SettingsSaveScope | null) => setScopes(current => {
    const next = { ...current }; if (scope) next[id] = scope; else delete next[id]; return next;
  }), []);
  const active = category ?? (wide ? 'display' : null);
  useEffect(() => { if (!isAdmin && category === 'review-policy') setCategory('display'); }, [category, isAdmin]);
  const guard = useCallback((id: SettingsCategory, action: () => void) => {
    const scope = scopes[id];
    if (scope?.dirty) confirmSettingsDiscard(() => { scope.discard(); action(); }, () => setCategory(id));
    else action();
  }, [scopes]);
  const close = useCallback(() => {
    const dirty = SETTINGS_CATEGORIES.find(item => scopes[item.id]?.dirty);
    if (dirty) confirmSettingsDiscard(() => { Object.values(scopes).forEach(scope => scope?.discard()); onClose?.(); }, () => setCategory(dirty.id));
    else onClose?.();
  }, [scopes, onClose]);
  useEffect(() => { registerCloseRequest?.(close); }, [close, registerCloseRequest]);
  const back = useCallback(() => {
    if (active === 'recurring-jobs' && jobs.kind !== 'list') {
      if (jobs.kind === 'history') setJobs({ kind: 'editor', jobId: jobs.jobId });
      else guard('recurring-jobs', () => setJobs({ kind: 'list' }));
    } else if (active === 'persistent' && persistent.kind !== 'list') guard('persistent', () => setPersistent({ kind: 'list' }));
    else setCategory(null);
  }, [active, jobs, persistent, guard]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!connectionOnly && (category || jobs.kind !== 'list' || persistent.kind !== 'list')) { back(); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [category, jobs.kind, persistent.kind, connectionOnly, back]);
  const title = connectionOnly ? '서버에 연결' : active ? SETTINGS_CATEGORIES.find(item => item.id === active)?.label : '설정';
  const scope = active && (active !== 'recurring-jobs' || jobs.kind === 'editor') && (active !== 'persistent' || persistent.kind === 'editor') ? scopes[active] : null;
  const changeConnection = useCallback((action: () => void) => {
    const dirty = SETTINGS_CATEGORIES.find(item => item.id !== 'connection' && scopes[item.id]?.dirty);
    if (dirty) confirmSettingsDiscard(() => { Object.entries(scopes).forEach(([id, scope]) => { if (id !== 'connection') scope?.discard(); }); action(); }, () => setCategory(dirty.id));
    else action();
  }, [scopes]);
  const context = useMemo(() => ({ category: active, wide, columns: width - (wide ? 240 : 0) >= TABLET_BREAKPOINT, jobs, setJobs, persistent, setPersistent, register, select: setCategory, guard, changeConnection }), [active, wide, width, jobs, persistent, register, guard, changeConnection]);
  return <SettingsWorkspaceContext.Provider value={context}>
    <SafeAreaView testID="settings-safe-area" style={styles.root} edges={flattened ? [] : bottomSafeAreaOwner === 'parent' ? ['left', 'right', 'top'] : ['left', 'right', 'bottom', 'top']} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <AppKeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View testID="settings-modal-header" style={styles.header}>
          {!connectionOnly && !wide && active ? <TouchableOpacity style={styles.headerAction} accessibilityRole="button" accessibilityLabel="모든 설정으로 돌아가기" onPress={() => setCategory(null)}><Ionicons name="chevron-back" size={t.iconSize.standard} color={t.colors.accent}/><Text style={styles.actionText}>설정</Text></TouchableOpacity> : null}
          {active === 'recurring-jobs' && jobs.kind !== 'list' ? <TouchableOpacity style={styles.headerAction} accessibilityRole="button" accessibilityLabel="반복 작업 이전 화면으로 돌아가기" onPress={back}><Ionicons name="chevron-back" size={t.iconSize.standard} color={t.colors.accent}/><Text style={styles.actionText}>{jobs.kind === 'history' ? '편집' : '목록'}</Text></TouchableOpacity> : null}
          {active === 'persistent' && persistent.kind !== 'list' ? <TouchableOpacity style={styles.headerAction} accessibilityRole="button" accessibilityLabel="영구 에이전트 세션 이전 화면으로 돌아가기" onPress={back}><Ionicons name="chevron-back" size={t.iconSize.standard} color={t.colors.accent}/><Text style={styles.actionText}>목록</Text></TouchableOpacity> : null}
          <Text style={styles.title}>{title}</Text>
          {onClose ? <TouchableOpacity testID="settings-modal-close" accessibilityRole="button" accessibilityLabel="설정 닫기" style={styles.headerAction} onPress={close}><Text style={styles.actionText}>완료</Text></TouchableOpacity> : null}
        </View>
        <View testID={wide ? 'settings-wide-layout' : 'settings-compact-layout'} style={[styles.body, wide && styles.wide]}>
          <ScrollView testID={wide ? 'settings-sidebar-scroll' : 'settings-phone-index'} style={[wide ? styles.sidebar : styles.root, (connectionOnly || (!wide && active)) && styles.hidden]} accessibilityElementsHidden={connectionOnly || (!wide && active !== null)} importantForAccessibility={connectionOnly || (!wide && active !== null) ? 'no-hide-descendants' : 'auto'} contentContainerStyle={styles.index}>
            {!wide ? <View style={styles.introduction}><Text style={styles.introTitle}>내 작업 환경</Text><Text style={styles.help}>변경할 항목을 선택하세요.</Text></View> : null}
            <SettingsCategorySidebar compact={!wide} selected={active} onSelect={setCategory} showAdmin={isAdmin} dirty={Object.keys(scopes).filter(id => scopes[id as SettingsCategory]?.dirty) as SettingsCategory[]}/>
          </ScrollView>
          <View style={[styles.root, !active && styles.hidden]} accessibilityElementsHidden={!active} importantForAccessibility={!active ? 'no-hide-descendants' : 'auto'}>
            <SettingsContent flattened category={active ?? 'display'} showAdmin={isAdmin} connectionOnly={connectionOnly}/>
            {scope ? <View testID="settings-active-footer" style={[styles.footer, { paddingBottom: t.spacing.md + extraBottomPadding }]}>
              {scope.dirty ? <GlassButton accessibilityLabel="변경 버리기" onPress={() => active && guard(active, () => undefined)} style={styles.footerAction}><Text style={styles.actionText}>변경 버리기</Text></GlassButton> : null}
              <GlassButton variant="primary" testID={scope.saveTestID ?? 'settings-scope-save'} accessibilityLabel={scope.saveLabel ?? '저장'} disabled={scope.busy || scope.canSave === false} onPress={() => void scope.save()} style={styles.footerAction}><Text style={styles.primaryText}>{scope.busy ? '처리 중…' : scope.saveLabel ?? '저장'}</Text></GlassButton>
            </View> : null}
          </View>
        </View>
      </AppKeyboardAvoidingView>
    </SafeAreaView>
  </SettingsWorkspaceContext.Provider>;
}
function makeStyles(t: DesignTokens) { return StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0 }, body: { flex: 1, minHeight: 0 }, wide: { flexDirection: 'row' }, hidden: { display: 'none' },
  sidebar: { width: 240, flexGrow: 0, borderRightWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, backgroundColor: t.colors.surfaceMuted }, index: { paddingBottom: t.spacing.xl },
  header: { minHeight: t.hitTarget.min + t.spacing.sm, paddingHorizontal: t.foundation.pageInset, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm },
  headerAction: { minHeight: t.hitTarget.min, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs },
  title: { flex: 1, ...t.foundation.typography.navigation, color: t.colors.textPrimary }, actionText: { ...t.foundation.typography.body, color: t.colors.accent, fontWeight: '600' }, primaryText: { ...t.foundation.typography.body, color: t.colors.accentText, fontWeight: '700' },
  introduction: { padding: t.foundation.pageInset, gap: t.spacing.sm }, introTitle: { ...t.foundation.typography.section, color: t.colors.textPrimary }, help: { ...t.foundation.typography.body, color: t.colors.textSecondary },
  footer: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm, padding: t.cardLayout.padding, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border }, footerAction: { flexGrow: 1 },
}); }

export function FirstConnectionSettingsScreen() { return <SettingsScreen connectionOnly showTitle/>; }
