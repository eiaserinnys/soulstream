import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LiquidGlassButton } from '../LiquidGlassButton';
import { useTokens } from '../../theme';

export function ChatNewMessageButton({ onPress }: { onPress: () => void }) {
  const t = useTokens();
  return (
    <LiquidGlassButton
      iconOnly
      size="compact"
      variant="plain"
      borderRadius={t.foundation.radius.round}
      style={{ backgroundColor: t.persistentSession.panel }}
      accessibilityLabel="새 메시지로 이동"
      onPress={onPress}
      testID="chat-new-message-button"
      surfaceTestID="chat-new-message-visual"
    >
      <Ionicons name="arrow-down-outline" size={t.iconSize.action} color={t.colors.textPrimary} />
    </LiquidGlassButton>
  );
}
