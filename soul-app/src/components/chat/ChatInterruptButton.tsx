import React from 'react';
import { ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ChatBodyStyles } from './ChatBody.styles';
import { DESIGN_ICON_SIZE } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';

interface Props {
  interrupting: boolean;
  disabled: boolean;
  styles: ChatBodyStyles;
  accentTextColor: string;
  textPrimaryColor: string;
  onPress: () => void;
  presentation?: 'default' | 'manuscript';
}

export function ChatInterruptButton({
  interrupting,
  disabled,
  styles,
  accentTextColor,
  textPrimaryColor,
  onPress,
  presentation = 'default',
}: Props) {
  return (
    <CompactTouchTarget
      testID="chat-composer-interrupt-button"
      surfaceTestID="chat-composer-interrupt-visual"
      frameStyle={styles.composerControlFrame}
      surfaceStyle={presentation === 'manuscript'
        ? [styles.composerSecondaryControl, disabled && styles.composerControlDisabled]
        : styles.stopBtn}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel="세션 중단"
      accessibilityState={{ disabled, busy: interrupting }}
    >
      {interrupting ? (
        <ActivityIndicator size="small" color={presentation === 'manuscript' ? textPrimaryColor : accentTextColor} />
      ) : (
        <Ionicons name={presentation === 'manuscript' ? 'stop-outline' : 'stop'}
          color={presentation === 'manuscript' ? textPrimaryColor : accentTextColor} size={DESIGN_ICON_SIZE.standard} />
      )}
    </CompactTouchTarget>
  );
}
