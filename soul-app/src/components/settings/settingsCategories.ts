import type Ionicons from '@expo/vector-icons/Ionicons';
import type React from 'react';

export type SettingsCategory =
  | 'display'
  | 'connection'
  | 'backends'
  | 'recurring-jobs'
  | 'review-policy'
  | 'diagnostics';

export interface SettingsCategoryDefinition {
  id: SettingsCategory;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  { id: 'display', label: '디스플레이', icon: 'color-palette-outline' },
  { id: 'connection', label: '연결', icon: 'server-outline' },
  { id: 'backends', label: 'AI 백엔드', icon: 'terminal-outline' },
  { id: 'recurring-jobs', label: '반복 작업', icon: 'repeat-outline' },
  { id: 'review-policy', label: '세션 검수', icon: 'checkmark-done-outline' },
  { id: 'diagnostics', label: '진단', icon: 'pulse-outline' },
];
