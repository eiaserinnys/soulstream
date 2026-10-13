import React, { useId } from 'react';
import { View } from 'react-native';
import { createPrimitiveRoles, useTokens } from '../../theme';

/** Scopes both rich citation links and enriched-markdown fallback links. */
export function ChatUiLinkFocusScope({ children }: { children: React.ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const t = useTokens();
  const scopeId = `chat-ui-link-focus-${id}`;
  return <View nativeID={scopeId} style={{ minWidth: 0 }}>
    <style>{`#${scopeId} a:focus { outline: none !important; outline-width: 0 !important; color: ${createPrimitiveRoles(t).input.focusedColor} !important; background-color: ${t.colors.accentTint}; text-decoration: underline; }`}</style>
    {children}
  </View>;
}
