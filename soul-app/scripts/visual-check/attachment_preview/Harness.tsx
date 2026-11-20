import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { MessageAttachments } from '../../../src/components/MessageAttachments';
import { useAuthStore } from '../../../src/store/authStore';
import { useSettingsStore } from '../../../src/store/settingsStore';
import { useTokens } from '../../../src/theme';
import { attachmentPreviewHarnessItems } from './fixtures';

// Same store bootstrapping the component-review shell uses for ?section=attachments:
// no login, public node, fixtures served from the same origin.
const search = typeof window === 'undefined' ? '' : window.location.search;
useSettingsStore.setState({
  serverUrl: typeof window === 'undefined' ? '' : window.location.origin,
  nodeId: 'public-node',
  appearance: new URLSearchParams(search).get('theme') === 'dark' ? 'dark' : 'light',
});
useAuthStore.setState({ jwt: null, authRejected: false });

export function Harness() {
  const t = useTokens();
  const items = useMemo(() => attachmentPreviewHarnessItems(), []);
  return <View testID="attachment-preview-harness" style={{ flex: 1, backgroundColor: t.colors.background }}>
    <ScrollView
      testID="attachment-preview-harness-scroll"
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <MessageAttachments items={items} role="assistant" />
    </ScrollView>
  </View>;
}
