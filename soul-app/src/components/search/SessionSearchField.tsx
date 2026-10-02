import React, { forwardRef, useMemo } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GlassSurface, GlassButton } from '../GlassSurface';
import { useTokens, type DesignTokens } from '../../theme';

export const SessionSearchField = forwardRef<TextInput, {
  value: string;
  onChangeText(value: string): void;
  onFilterPress?(): void;
  filterActive?: boolean;
  autoFocus?: boolean;
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  onFocus?: TextInputProps['onFocus'];
  placeholder?: string;
  testID?: string;
  accessibilityLabel?: string;
}>(function SessionSearchField({
  value,
  onChangeText,
  onFilterPress,
  filterActive = false,
  autoFocus = false,
  onSubmitEditing,
  onFocus,
  placeholder = '세션 및 대화 검색',
  testID = 'session-search-input',
  accessibilityLabel = '세션 및 대화 검색',
}, ref) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <GlassSurface role="glassDense" style={styles.surface}>
      <View style={styles.field}>
        <Ionicons
          name="search-outline"
          color={t.colors.textMuted}
          size={t.iconSize.standard}
        />
        <TextInput
          ref={ref}
          testID={testID}
          accessibilityLabel={accessibilityLabel}
          value={value}
          autoFocus={autoFocus}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          placeholder={placeholder}
          placeholderTextColor={t.colors.textPlaceholder}
          style={styles.input}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          onFocus={onFocus}
        />
        {value && !onFilterPress ? (
          <GlassButton
            accessibilityLabel="검색어 지우기"
            onPress={() => onChangeText('')}
            style={styles.iconButton}
          >
            <Ionicons
              name="close-circle"
              color={t.colors.textMuted}
              size={t.iconSize.standard}
            />
          </GlassButton>
        ) : null}
        {onFilterPress ? (
          <GlassButton
            accessibilityLabel={filterActive ? '검색 필터, 적용됨' : '검색 필터'}
            onPress={onFilterPress}
            style={[styles.iconButton, filterActive && styles.activeFilter]}
          >
            <Ionicons
              name="options-outline"
              color={filterActive ? t.colors.accent : t.colors.textMuted}
              size={t.iconSize.standard}
            />
          </GlassButton>
        ) : null}
      </View>
    </GlassSurface>
  );
});

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    surface: {
      minHeight: t.foundation.minHeight.field,
      borderRadius: t.radius.lg,
      overflow: 'hidden',
    },
    field: {
      minHeight: t.foundation.minHeight.field,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: t.spacing.md,
      gap: t.spacing.sm,
    },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: t.foundation.minHeight.field,
      color: t.colors.textPrimary,
      ...t.foundation.typography.body,
    },
    iconButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activeFilter: {
      borderColor: t.colors.accent,
    },
  });
}
