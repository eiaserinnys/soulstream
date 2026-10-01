import React from 'react';
import { ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { makeStyles } from './ChatBody.styles';

interface AttachmentPickerButtonProps {
  onPress(): void;
  uploading: boolean;
  disabled?: boolean;
  testID?: string;
  surfaceTestID?: string;
}

export function AttachmentPickerButton({
  onPress,
  uploading,
  disabled = false,
  testID = 'chat-composer-attach-button',
  surfaceTestID = 'chat-composer-attach-visual',
}: AttachmentPickerButtonProps) {
  const t = useTokens();
  const styles = React.useMemo(() => makeStyles(t), [t]);
  const controlsDisabled = uploading || disabled;

  return (
    <CompactTouchTarget
      testID={testID}
      surfaceTestID={surfaceTestID}
      accessibilityRole="button"
      accessibilityLabel="첨부 추가"
      accessibilityState={{ disabled: controlsDisabled }}
      disabled={controlsDisabled}
      frameStyle={styles.composerControlFrame}
      surfaceStyle={[
        styles.composerSecondaryControl,
        controlsDisabled && styles.composerControlDisabled,
      ]}
      onPress={() => {
        if (!controlsDisabled) onPress();
      }}
    >
      {uploading ? (
        <ActivityIndicator size="small" color={t.colors.textMuted} />
      ) : (
        <Ionicons name="add" color={t.colors.textMuted} size={t.iconSize.action} />
      )}
    </CompactTouchTarget>
  );
}
