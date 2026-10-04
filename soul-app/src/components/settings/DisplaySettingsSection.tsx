import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageSourcePropType,
} from 'react-native';
import type {
  Appearance,
  WallpaperMode,
  WallpaperSettings,
} from '../../store/settingsStore';
import { useDeviceType, useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { SettingsDivider, SettingsSection } from './SettingsSection';
import { SettingsSegmentedControl } from './SettingsSegmentedControl';
import { SettingsPhoto } from './SettingsPhoto';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';

const APPEARANCE_OPTIONS = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
] as const;

const WALLPAPER_OPTIONS: readonly {
  value: WallpaperMode;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  { value: 'bokeh', label: '보케', icon: 'sparkles-outline' },
  { value: 'metal', label: '메탈', icon: 'layers-outline' },
  { value: 'photo', label: '사진', icon: 'image-outline' },
  { value: 'plain', label: '단색', icon: 'color-fill-outline' },
];

export function DisplaySettingsSection({
  flattened,
  appearance,
  wallpaper,
  wallpaperPreviewSource,
  savingBackground,
  status,
  onAppearanceChange,
  onWallpaperModeChange,
  onPickBackground,
  onResetBackground,
}: {
  flattened: boolean;
  appearance: Appearance;
  wallpaper: WallpaperSettings;
  wallpaperPreviewSource: ImageSourcePropType | null;
  savingBackground: boolean;
  status?: string | null;
  onAppearanceChange(value: Appearance): void;
  onWallpaperModeChange(value: WallpaperMode): void;
  onPickBackground(): void;
  onResetBackground(): void;
}) {
  const t = useTokens();
  const deviceWide = useDeviceType() !== 'phone';
  const workspace = useSettingsWorkspace();
  const wide = workspace ? workspace.columns : deviceWide;
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <SettingsSection id="display" title="화면과 배경" flattened={flattened}>
      <View style={styles.block}>
        <Text style={styles.rowLabel}>외양</Text>
        <SettingsSegmentedControl
          id="appearance"
          value={appearance}
          options={APPEARANCE_OPTIONS}
          onChange={onAppearanceChange}
        />
      </View>
      <SettingsDivider />
      <View style={styles.block}>
        <Text style={styles.rowLabel}>배경</Text>
        <View testID="settings-wallpaper-grid" style={[styles.wallpaperGrid]}>
          {WALLPAPER_OPTIONS.map((option) => {
            const selected = wallpaper.mode === option.value;
            return (
              <TouchableOpacity
                key={option.value}
                testID={`settings-wallpaper-${option.value}`}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{ selected, disabled: savingBackground }}
                disabled={savingBackground}
                style={[styles.wallpaperTile, wide && styles.wallpaperTileWide, selected && styles.wallpaperTileSelected]}
                onPress={() => onWallpaperModeChange(option.value)}
              >
                {option.value === 'photo' ? <SettingsPhoto testID="settings-wallpaper-photo-tile" source={wallpaperPreviewSource} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: t.foundation.radius.field }}/> : <Ionicons
                  name={option.icon}
                  color={selected ? t.colors.accent : t.colors.textSecondary}
                  size={t.iconSize.prominent}
                />}
                <Text style={[styles.tileLabel, selected && styles.tileLabelSelected]}>
                  {option.label}
                </Text>
                {selected ? (
                  <Ionicons
                    testID={`settings-wallpaper-${option.value}-checkmark`}
                    style={{position: 'absolute', top: t.spacing.sm, right: t.spacing.sm}}
                    name="checkmark-circle"
                    color={t.colors.accent}
                    size={t.iconSize.standard}
                  />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
        {wallpaper.mode === 'photo' ? (
          <View style={[styles.block, styles.photoControls]}>
            <Text style={styles.rowLabel}>내 사진</Text>
            <SettingsPhoto
                expandable testID="settings-wallpaper-preview"
                source={wallpaperPreviewSource}
                style={styles.wallpaperPreview}
              />
            <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>{status ?? (wallpaper.customImage ? '내 사진을 사용 중입니다.' : '사진을 선택하면 바로 적용합니다.')}</Text>
            <View style={styles.actionRow}>
              <GlassButton
                testID="settings-upload-background"
                surfaceTestID="settings-upload-background-surface"
                style={styles.action}
                contentStyle={styles.secondaryButtonContent}
                disabled={savingBackground}
                onPress={onPickBackground}
              >
                {savingBackground ? (
                  <ActivityIndicator size="small" color={t.colors.accent} />
                ) : (
                  <Text style={styles.secondaryText}>이미지 업로드</Text>
                )}
              </GlassButton>
              {wallpaper.customImage ? (
                <GlassButton
                  testID="settings-reset-background"
                  surfaceTestID="settings-reset-background-surface"
                  style={styles.action}
                  contentStyle={styles.secondaryButtonContent}
                  disabled={savingBackground}
                  onPress={onResetBackground}
                >
                  <Text style={styles.secondaryText}>기본값 복원</Text>
                </GlassButton>
              ) : null}
            </View>
          </View>
        ) : null}
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
    wallpaperGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    wallpaperTile: {
      width: '47%',
      flexGrow: 1,
      minHeight: t.hitTarget.min,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.md,
      borderRadius: t.foundation.radius.field,
      borderWidth: 1,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.xs,
    },
    wallpaperTileWide: { width: '22%' },
    wallpaperTileSelected: {
      borderColor: t.colors.accent,
      backgroundColor: t.colors.accentTint,
    },
    tileLabel: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
      textAlign: 'center',
    },
    tileLabelSelected: { color: t.colors.textPrimary, fontWeight: '700' },
    photoControls: { gap: t.spacing.md },
    wallpaperPreview: {
      width: '100%',
      maxWidth: 480,
      maxHeight: 270,
      aspectRatio: 16 / 9,
      alignSelf: 'center',
      borderRadius: t.foundation.radius.field,
      borderWidth: 1,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surfaceMuted,
    },
    actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
    action: { flex: 1, minWidth: 140 },
    secondaryButtonContent: { minHeight: t.foundation.minHeight.secondary },
    secondaryText: {
      ...t.foundation.typography.body,
      color: t.colors.link,
      fontWeight: '600',
    },
  });
}
