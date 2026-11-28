import React, { useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  createPrimitiveRoles,
  useTokens,
  type DesignTokens,
} from '../../theme';
import { capsuleRadius } from '../../theme/tokens';

type ToggleAction = 'starred';

export function FolderWorkspaceToggleActions({
  starred,
  starredDisabled = false,
  showToggles = true,
  onToggleStarred,
  onOpenMenu,
  onError,
}: {
  starred: boolean;
  starredDisabled?: boolean;
  showToggles?: boolean;
  onToggleStarred(): Promise<unknown>;
  onOpenMenu?: () => void;
  onError(action: ToggleAction, error: unknown): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View testID="task-workspace-toggle-actions" style={styles.row}>
      {showToggles ? <>
        <ToggleIconButton
          testID="task-workspace-starred-toggle"
          active={starred}
          label={starred ? '중요 폴더 지정 해제' : '중요 폴더로 지정'}
          disabled={starredDisabled}
          loading={false}
          styles={styles}
          icon={(
            <Ionicons
              testID="task-workspace-starred-icon"
              name={starred ? 'star' : 'star-outline'}
              size={t.iconSize.navigation}
              color={starred ? t.colors.accent : t.colors.textSecondary}
            />
          )}
          onToggle={onToggleStarred}
          onError={(error) => onError('starred', error)}
        />
      </> : null}
      {onOpenMenu ? <TouchableOpacity
        testID="folder-workspace-menu"
        accessibilityRole="button"
        accessibilityLabel="폴더 메뉴"
        style={[styles.button, styles.buttonInactive]}
        onPress={onOpenMenu}
      >
        <Ionicons name="ellipsis-horizontal" size={t.iconSize.navigation} color={t.colors.textSecondary} />
      </TouchableOpacity> : null}
    </View>
  );
}

function ToggleIconButton({
  testID,
  active,
  label,
  disabled,
  loading,
  styles,
  icon,
  onToggle,
  onError,
}: {
  testID: string;
  active: boolean;
  label: string;
  disabled: boolean;
  loading: boolean;
  styles: ReturnType<typeof makeStyles>;
  icon: React.ReactNode;
  onToggle(): Promise<unknown>;
  onError(error: unknown): void;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const controlsDisabled = disabled || loading || pending;

  const run = async () => {
    if (controlsDisabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onToggle();
    } catch (error) {
      onError(error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{
        selected: active,
        disabled: controlsDisabled,
        busy: loading || pending,
      }}
      activeOpacity={0.7}
      disabled={controlsDisabled}
      style={[
        styles.button,
        active ? styles.buttonActive : styles.buttonInactive,
        controlsDisabled && styles.buttonDisabled,
      ]}
      onPress={() => { void run(); }}
    >
      {icon}
    </TouchableOpacity>
  );
}

function makeStyles(t: DesignTokens) {
  const iconFrame = createPrimitiveRoles(t).iconFrame;
  const size = Math.max(t.hitTarget.min, iconFrame.minHeight);
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: t.spacing.xs,
    },
    button: {
      width: size,
      height: size,
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      borderRadius: capsuleRadius(size),
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
    },
    buttonActive: {
      backgroundColor: t.colors.accentTint,
      borderColor: t.colors.accent,
    },
    buttonInactive: {
      backgroundColor: iconFrame.backgroundColor,
      borderColor: t.colors.border,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
  });
}
