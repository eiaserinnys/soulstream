import React from 'react';
import { Text } from 'react-native';
import { useTokens } from '../../theme';
import { useChatUiNotice } from './ChatUiControllerProvider';

export function ChatUiNotice() {
  const t = useTokens();
  const notice = useChatUiNotice();
  return notice ? <Text testID="chat-ui-action-notice" accessibilityLiveRegion="polite" style={{
    fontSize: t.chatFontSize.meta, lineHeight: t.chatFontSize.meta * t.lineHeightRatio, color: t.colors.textSecondary,
  }}>{notice}</Text> : null;
}
