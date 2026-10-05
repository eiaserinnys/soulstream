import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useTokens } from '../../theme';
import { PersistentSessionEditor, PersistentSessionsList } from './PersistentSessionViews';
import { settingsPanelPage } from './SettingsFormParts';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';

/** Persistent agent sessions: a list that opens one editor. The settings host owns the footer and the way back. */
export function PersistentSessionsSettingsSection({ serverUrl }: { serverUrl: string }) {
  const t = useTokens();
  const workspace = useSettingsWorkspace();
  const [listRevision, setListRevision] = useState(0);
  if (!workspace) return null;
  const { persistent, setPersistent } = workspace;
  return <View testID="persistent-sessions-panel" style={{ flex: 1, minHeight: 0 }}>
    <ScrollView {...settingsPanelPage(t, persistent.kind !== 'list')} testID="settings-persistent-list-scroll">
      <PersistentSessionsList serverUrl={serverUrl} refreshKey={listRevision} onCreate={() => setPersistent({ kind: 'editor' })} onEdit={(session) => setPersistent({ kind: 'editor', sessionId: session.session_id })} />
    </ScrollView>
    {persistent.kind === 'editor' ? <ScrollView {...settingsPanelPage(t, false)} testID="settings-persistent-editor-scroll">
      <PersistentSessionEditor key={persistent.sessionId ?? 'new'} serverUrl={serverUrl} sessionId={persistent.sessionId} onDone={() => { setListRevision((value) => value + 1); setPersistent({ kind: 'list' }); }} />
    </ScrollView> : null}
  </View>;
}
