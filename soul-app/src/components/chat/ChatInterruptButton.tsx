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
  onPress: () => void;
}

export function ChatInterruptButton({
  interrupting,
  disabled,
  styles,
  accentTextColor,
  onPress,
}: Props) {
  return (
    <CompactTouchTarget
      testID="chat-composer-interrupt-button"
      surfaceTestID="chat-composer-interrupt-visual"
      frameStyle={styles.composerControlFrame}
      surfaceStyle={[styles.stopBtn, interrupting && styles.stopBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel="세션 중단"
      accessibilityState={{ disabled }}
    >
      {interrupting ? (
        <ActivityIndicator size="small" color={accentTextColor} />
      ) : (
        <Ionicons name="stop" color={accentTextColor} size={DESIGN_ICON_SIZE.standard} />
      )}
    </CompactTouchTarget>
  );
}
