import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { useDeviceType, useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { SettingsCategorySidebar } from './SettingsCategorySidebar';
import { SETTINGS_CATEGORIES, type SettingsCategory } from './settingsCategories';
import { useDashboardAdminStatus } from './useDashboardAdminStatus';

export function SettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const deviceType = useDeviceType();
  const [category, setCategory] = useState<SettingsCategory | null>(null);
  const wide = deviceType !== 'phone';
  const isAdmin = useDashboardAdminStatus(visible);

  useEffect(() => { if (!visible) setCategory(null); }, [visible]);
  useEffect(() => {
    if (!isAdmin && category === 'review-policy') setCategory('display');
  }, [category, isAdmin]);

  return (
    <AppModalSurface
      visible={visible}
      variant="expanded"
      modalId="modal_settings"
      animationType="fade"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      surfaceTestID="settings-modal"
      safeAreaTestID="settings-modal-safe-area"
    >
      <View testID="settings-modal-header" style={styles.header}>
        {!wide && category ? <TouchableOpacity style={styles.back} accessibilityLabel="모든 설정으로 돌아가기" onPress={() => setCategory(null)}><Ionicons name="chevron-back" size={t.iconSize.standard} color={t.colors.accent}/><Text style={styles.close}>설정</Text></TouchableOpacity> : null}
        <Text style={[styles.title, !wide && category ? styles.detailTitle : null]}>{!wide && category ? SETTINGS_CATEGORIES.find(item => item.id === category)?.label : '설정'}</Text>
        <TouchableOpacity
          testID="settings-modal-close"
          style={styles.closeButton}
          onPress={onClose}
          accessibilityLabel="설정 닫기"
          accessibilityRole="button"
        >
          <Text style={styles.close}>완료</Text>
        </TouchableOpacity>
      </View>
      {wide ? (
        <View testID="settings-wide-layout" style={styles.wideLayout}>
          <SettingsCategorySidebar
            selected={category ?? 'display'}
            onSelect={setCategory}
            showAdmin={isAdmin}
          />
          <View style={styles.detail}>
            <SettingsScreen
              showTitle={false}
              flattened
              category={category ?? 'display'}
              showAdmin={isAdmin}
            />
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          {!category ? <ScrollView testID="settings-phone-index" contentContainerStyle={styles.indexBody}>
            <View style={styles.introduction}><Text style={styles.introTitle}>내 작업 환경</Text><Text style={styles.introDescription}>변경할 항목을 선택하세요.</Text></View>
            <SettingsCategorySidebar compact selected={null} onSelect={setCategory} showAdmin={isAdmin}/>
          </ScrollView> : null}
          <View style={[styles.body, !category && styles.hidden]}>
            <SettingsScreen showTitle={false} flattened preserveSections category={category ?? 'display'} showAdmin={isAdmin}/>
          </View>
        </View>
      )}
    </AppModalSurface>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: t.foundation.pageInset,
    },
    title: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.navigation,
    },
    closeButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    close: {
      color: t.colors.accent,
      ...t.foundation.typography.body,
      fontWeight: '700',
    },
    body: { flex: 1 },
    hidden: { display: 'none' },
    indexBody: { paddingBottom: t.spacing.xl },
    introduction: { paddingHorizontal: t.foundation.pageInset, paddingTop: t.spacing.lg, paddingBottom: t.spacing.sm, gap: t.spacing.sm },
    introTitle: { ...t.foundation.typography.section, color: t.colors.textPrimary },
    introDescription: { ...t.foundation.typography.body, color: t.colors.textSecondary },
    back: { minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.spacing.xxs },
    detailTitle: { flex: 1, textAlign: 'center' },
    wideLayout: { flex: 1, flexDirection: 'row' },
    detail: { flex: 1, minWidth: 0 },
  });
}
