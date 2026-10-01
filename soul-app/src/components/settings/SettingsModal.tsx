import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { useDeviceType, useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { SettingsCategorySidebar } from './SettingsCategorySidebar';
import type { SettingsCategory } from './settingsCategories';
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
  const [category, setCategory] = useState<SettingsCategory>('display');
  const wide = deviceType !== 'phone';
  const isAdmin = useDashboardAdminStatus(visible);

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
        <Text style={styles.title}>설정</Text>
        <TouchableOpacity
          testID="settings-modal-close"
          style={styles.closeButton}
          onPress={onClose}
          accessibilityLabel="설정 닫기"
          accessibilityRole="button"
        >
          <Text style={styles.close}>닫기</Text>
        </TouchableOpacity>
      </View>
      {wide ? (
        <View testID="settings-wide-layout" style={styles.wideLayout}>
          <SettingsCategorySidebar
            selected={category}
            onSelect={setCategory}
            showAdmin={isAdmin}
          />
          <View style={styles.detail}>
            <SettingsScreen
              showTitle={false}
              flattened
              category={category}
              showAdmin={isAdmin}
            />
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          <SettingsScreen showTitle={false} flattened showAdmin={isAdmin} />
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
    wideLayout: { flex: 1, flexDirection: 'row' },
    detail: { flex: 1, minWidth: 0 },
  });
}
