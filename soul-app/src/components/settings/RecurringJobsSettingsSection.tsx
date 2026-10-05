import React, { useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import { openPlannerSessionWorkspace } from '../../lib/planner-folder-workspace';
import { useTokens } from '../../theme';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';
import { SettingsSection } from './SettingsSection';
import { settingsPanelPage } from './SettingsFormParts';
import {
  RecurringJobEditor,
  RecurringJobHistory,
  RecurringJobsList,
} from './RecurringJobViews';

type WidePanel =
  | { kind: 'list' }
  | { kind: 'editor'; jobId?: string }
  | { kind: 'history'; jobId: string };

export function RecurringJobsSettingsSection({
  flattened,
  serverUrl,
  onOpenRecurringJobs,
}: {
  flattened: boolean;
  serverUrl: string;
  /** Phone navigation owns the three concrete stack routes. */
  onOpenRecurringJobs?: () => void;
}) {
  const t = useTokens();
  const workspace = useSettingsWorkspace();
  const [localPanel, setLocalPanel] = useState<WidePanel>({ kind: 'list' });
  const panel = workspace?.jobs ?? localPanel;
  const setPanel = workspace?.setJobs ?? setLocalPanel;
  const [editorId, setEditorId] = useState<string | undefined>();
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [hasEditor, setHasEditor] = useState(false);
  const openEditor = (jobId?: string) => {
    const open = () => { setEditorId(jobId); if (editorId !== jobId) setHistoryId(null); setHasEditor(true); setPanel({ kind: 'editor', jobId }); };
    if (workspace && hasEditor && editorId !== jobId) workspace.guard('recurring-jobs', open); else open();
  };
  if (workspace) {
    const hidden = (kind: WidePanel['kind']) => panel.kind !== kind;
    const page = (kind: WidePanel['kind']) => settingsPanelPage(t, hidden(kind));
    return <View testID="wide-recurring-jobs-panel" style={{ flex: 1, minHeight: 0 }}>
      <ScrollView {...page('list')} testID="settings-jobs-list-scroll"><RecurringJobsList serverUrl={serverUrl} onCreate={() => openEditor()} onEdit={job => openEditor(job.job_id)} refreshKey={listRevision}/></ScrollView>
      {hasEditor ? <ScrollView {...page('editor')} testID="settings-jobs-editor-scroll"><RecurringJobEditor key={editorId ?? 'new'} serverUrl={serverUrl} jobId={editorId} onDone={() => { setHasEditor(false); setListRevision(value => value + 1); setPanel({ kind: 'list' }); }} onOpenHistory={jobId => { setHistoryId(jobId); setPanel({ kind: 'history', jobId }); }}/></ScrollView> : null}
      {historyId ? <ScrollView {...page('history')} testID="settings-jobs-history-scroll"><RecurringJobHistory serverUrl={serverUrl} jobId={historyId} onOpenSession={sessionId => openPlannerSessionWorkspace(sessionId)}/></ScrollView> : null}
    </View>;
  }
  if (onOpenRecurringJobs) {
    return <SettingsSection id="recurring-jobs" title="반복 작업" flattened={flattened}>
      <View style={{ gap: t.spacing.sm, padding: t.cardLayout.padding }}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>
          정해진 시간에 새 에이전트 세션을 실행하고 이력을 관리합니다.
        </Text>
        <TouchableOpacity
          testID="open-recurring-jobs"
          accessibilityRole="button"
          onPress={onOpenRecurringJobs}
          style={{ alignSelf: 'stretch', minHeight: t.hitTarget.min, justifyContent: 'center' }}
        >
          <Text style={{ ...t.foundation.typography.body, color: t.colors.accent, fontWeight: '700' }}>
            반복 작업 관리
          </Text>
        </TouchableOpacity>
      </View>
    </SettingsSection>;
  }
  return <SettingsSection id="recurring-jobs" title="반복 작업" flattened={flattened}>
    <View testID="wide-recurring-jobs-panel" style={{ padding: t.cardLayout.padding }}>
      {panel.kind === 'list' ? <RecurringJobsList serverUrl={serverUrl} onCreate={() => setPanel({ kind: 'editor' })} onEdit={(job) => setPanel({ kind: 'editor', jobId: job.job_id })} /> : null}
      {panel.kind === 'editor' ? <RecurringJobEditor serverUrl={serverUrl} jobId={panel.jobId} onDone={() => setPanel({ kind: 'list' })} onOpenHistory={(jobId) => setPanel({ kind: 'history', jobId })} /> : null}
      {panel.kind === 'history' ? <RecurringJobHistory serverUrl={serverUrl} jobId={panel.jobId} onOpenSession={(sessionId) => openPlannerSessionWorkspace(sessionId)} /> : null}
      {panel.kind !== 'list' ? <TouchableOpacity accessibilityRole="button" onPress={() => setPanel({ kind: 'list' })} style={{ alignSelf: 'stretch', minHeight: t.hitTarget.min, justifyContent: 'center', marginTop: t.spacing.md }}><Text style={{ color: t.colors.accent }}>목록으로</Text></TouchableOpacity> : null}
    </View>
  </SettingsSection>;
}
