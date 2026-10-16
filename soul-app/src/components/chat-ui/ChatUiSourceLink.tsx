import React from 'react';
import { Platform, Text } from 'react-native';
import type { Source } from '@soulstream/chat-ui';
import { useTokens } from '../../theme';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';

export function ChatUiSourceLink({ source }: { source: Source }) {
  const t = useTokens();
  const openLink = useOpenContentLink();
  const style = { fontSize: t.chatFontSize.meta, lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    color: t.colors.textSecondary, alignSelf: 'flex-start' as const };
  if (source.type === 'assumption') return <Text style={style}>{source.label}{source.note ? `: ${source.note}` : ''}</Text>;
  // RN web's Text renders an anchor for href. Press/Enter still call the same
  // app content-link policy, including internal navigation and external browser.
  const webProps = Platform.OS === 'web' ? { href: source.url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {};
  return <Text {...webProps} accessibilityRole="link" accessibilityLabel={source.label}
    onPress={event => {
      if (Platform.OS === 'web') event.preventDefault();
      void openLink(source.url);
    }} style={style}>{source.label}</Text>;
}
