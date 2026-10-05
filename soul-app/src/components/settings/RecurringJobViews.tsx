import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';

import {
  createApiClient,
  type RecurringJobDto,
  type RecurringJobRunDto,
  type RecurringJobWrite,
} from '../../api/client';
import { ApiHttpError } from '../../api/clientCore';
import { useSessionStore } from '../../store/sessionStore';
import { useTokens } from '../../theme';
import { SettingsOptionRow as OptionRow } from './SettingsOptionRow';
import { useSettingsSaveScope, confirmSettingsDiscard } from './SettingsWorkspaceContext';
import { safeErrorDetail } from '../../../../packages/soul-ui/src/lib/safe-error-detail';
import { SettingsSection } from './SettingsSection';
import {
  SettingsAction as Action,
  SettingsFormGroup as Group,
  SettingsInput as Input,
  SettingsListHeader,
  SettingsListRow,
  SettingsNotice as Notice,
  useSettingsFormStyles,
} from './SettingsFormParts';
import { RecurringSchedulePicker } from './RecurringSchedulePicker';
import {
  defaultRecurringSchedule,
  recurringScheduleExpressions,
  recurringScheduleFromExpressions,
  type RecurringScheduleDraft,
} from './recurringSchedule';

type EditorDraft = {
  name: string;
  prompt: string;
  timezone: string;
  schedule: RecurringScheduleDraft;
  nodeId: string;
  agentId: string;
  modelPreset: string | null;
  folderId: string;
  lateRunWindowSeconds: string;
  enabled: boolean;
};

export function RecurringJobsList({
  serverUrl,
  onCreate,
  onEdit,
  refreshKey = 0,
}: {
  serverUrl: string;
  onCreate(): void;
  onEdit(job: RecurringJobDto): void;
  /** Phone screen increments this after returning from editor/history. */
  refreshKey?: number;
}) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  const [jobs, setJobs] = useState<RecurringJobDto[]>([]);
  const [loading, setLoading] = useState(false);
  const requestRevision = useRef(0);
  useEffect(() => () => { ++requestRevision.current; }, [serverUrl]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++requestRevision.current;
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await createApiClient(serverUrl).listRecurringJobs(true);
      if (request === requestRevision.current) setJobs(result.jobs);
    } catch (cause) {
      if (request === requestRevision.current) setError(errorMessage(cause));
    } finally {
      if (request === requestRevision.current) setLoading(false);
    }
  }, [serverUrl]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  if (!serverUrl) return <Notice text="연결 설정을 저장하면 반복 작업을 관리할 수 있습니다." />;
  return (
    <View testID="recurring-jobs-list" style={styles.block}>
      <SettingsListHeader title="반복 작업" help="다음 실행 시각은 서버가 계산합니다."><Action label="새로고침" onPress={() => void load()} testID="recurring-jobs-refresh" /><Action label="새 작업" onPress={onCreate} /></SettingsListHeader>
      {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!loading && !error && jobs.length === 0 ? <Notice text="등록된 반복 작업이 없습니다." /> : null}
      {jobs.map((job) => <SettingsListRow key={job.job_id} testID={`recurring-job-${job.job_id}`} title={job.name} detail={job.archived_at ? '보관됨' : job.enabled ? `다음 실행 ${formatTime(job.next_run_at)}` : '일시정지됨'} onPress={() => onEdit(job)} />)}
    </View>
  );
}

export function RecurringJobEditor({
  serverUrl,
  jobId,
  onDone,
  onOpenHistory,
}: {
  serverUrl: string;
  jobId?: string;
  onDone(job: RecurringJobDto | null): void;
  onOpenHistory(jobId: string): void;
}) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  const identityRevision = useRef(0);
  const previewRevision = useRef(0);
  useEffect(() => { ++identityRevision.current; return () => { ++identityRevision.current; ++previewRevision.current; }; }, [serverUrl, jobId]);
  const [job, setJob] = useState<RecurringJobDto | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft());
  const promptDraft = usePersistentDraft('recurring-prompt', [jobId ?? 'new'], draft.prompt);
  const [targetsReload, setTargetsReload] = useState(0);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [nodes, setNodes] = useState<Array<{ nodeId: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string | null }>>([]);
  const [presets, setPresets] = useState<Array<{ id: string; label: string; available: boolean; reason_label?: string | null }>>([]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [previewTimezone, setPreviewTimezone] = useState('Asia/Seoul');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [loading, setLoading] = useState(Boolean(jobId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true; setLoadingNodes(true); setNodesError(null);
    void createApiClient(serverUrl).listNodes().then((result) => {
      if (active) setNodes(result.nodes.map((node) => ({ nodeId: node.nodeId })));
    }).catch(() => { if (active) setNodesError('실행 노드를 불러오지 못했습니다.'); }).finally(() => { if (active) setLoadingNodes(false); });
    return () => { active = false; };
  }, [serverUrl, targetsReload]);
  const loadExisting = useCallback(async ({ preserveDraft = false }: { preserveDraft?: boolean } = {}) => {
    if (!serverUrl || !jobId) {
      setJob(null);
      if (!preserveDraft) setDraft(emptyDraft());
      setLoading(false);
      return true;
    }
    const request = identityRevision.current;
    setLoading(true); setError(null);
    try {
      const result = await createApiClient(serverUrl).listRecurringJobs(true);
      if (request !== identityRevision.current) return false;
      const found = result.jobs.find((candidate) => candidate.job_id === jobId) ?? null;
      if (!found) {
        setError('반복 작업을 찾을 수 없습니다.');
        setJob(null);
        return false;
      }
      setJob(found);
      if (!preserveDraft) setDraft(draftFromJob(found));
      return true;
    } catch (cause) {
      if (request === identityRevision.current) setError(errorMessage(cause));
      return false;
    } finally {
      if (request === identityRevision.current) setLoading(false);
    }
  }, [jobId, serverUrl]);
  useEffect(() => { void loadExisting(); }, [loadExisting]);
  useEffect(() => {
    if (!serverUrl || !draft.nodeId) { setAgents([]); setPresets([]); return; }
    let active = true; setAgents([]); setPresets([]); setLoadingTargets(true); setTargetsError(null);
    const api = createApiClient(serverUrl);
    void Promise.all([api.listNodeAgents(draft.nodeId), api.listModelPresets(draft.nodeId)])
      .then(([agentResult, presetResult]) => {
        if (!active) return;
        setAgents(agentResult.agents);
        setPresets(presetResult.model_presets);
      })
      .catch(() => { if (active) setTargetsError('에이전트와 모델을 불러오지 못했습니다.'); }).finally(() => { if (active) setLoadingTargets(false); });
    return () => { active = false; };
  }, [draft.nodeId, serverUrl, targetsReload]);

  const update = (patch: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  useEffect(() => { ++previewRevision.current; setPreview([]); setPreviewError(null); setPreviewLoading(false); }, [draft.timezone, draft.schedule]);
  const previewSchedule = async () => {
    const request = ++previewRevision.current;
    setPreviewLoading(true); setPreviewError(null);
    try {
      const result = await createApiClient(serverUrl).previewRecurringSchedule({
        timezone: draft.timezone.trim(), schedule_expressions: recurringScheduleExpressions(draft.schedule),
      });
      if (request === previewRevision.current) { setPreview(result.nextRuns); setPreviewTimezone(draft.timezone.trim()); }
    } catch { if (request === previewRevision.current) setPreviewError('다음 실행을 계산하지 못했습니다. 다시 시도해 주세요.'); } finally { if (request === previewRevision.current) setPreviewLoading(false); }
  };
  const save = async () => {
    if (!promptDraft.ready || saving) return;
    const request = identityRevision.current;
    setSaving(true); setError(null);
    try {
      const submittedPrompt = promptDraft.value;
      const write = writeFromDraft({ ...draft, prompt: submittedPrompt });
      const api = createApiClient(serverUrl);
      const saved = job
        ? (await api.updateRecurringJob(job.job_id, { ...write, expected_version: job.version })).job
        : (await api.createRecurringJob({ ...write, idempotency_key: idempotency('create') })).job;
      if (request !== identityRevision.current) return;
      setJob(saved); setDraft(draftFromJob(saved)); promptDraft.clearIfMatches(submittedPrompt); onDone(saved);
    } catch (cause) {
      if (request !== identityRevision.current) return;
      if (isVersionConflict(cause) && job) {
        const refreshed = await loadExisting({ preserveDraft: true });
        setError(refreshed
          ? '다른 곳에서 작업이 변경됐습니다. 내 입력은 보존했습니다. 다시 저장하면 그 변경을 내 입력으로 덮어씁니다.'
          : '동시 수정은 감지됐지만 최신 버전을 불러오지 못했습니다. 입력은 보존했습니다. 새로고침 후 다시 저장하세요.');
      } else setError(errorMessage(cause));
    } finally { if (request === identityRevision.current) setSaving(false); }
  };
  const updateEnabled = async () => {
    if (!job || saving) return;
    const request = identityRevision.current;
    setSaving(true); setError(null);
    try {
      const saved = (await createApiClient(serverUrl).updateRecurringJob(job.job_id, {
        expected_version: job.version, enabled: !job.enabled,
      })).job;
      if (request !== identityRevision.current) return;
      setJob(saved);
      if (!dirty) { setDraft(draftFromJob(saved)); onDone(saved); }
    } catch (cause) { if (request === identityRevision.current) setError(errorMessage(cause)); } finally { if (request === identityRevision.current) setSaving(false); }
  };
  const runNow = async () => {
    if (!job || saving) return;
    const request = identityRevision.current;
    setSaving(true); setError(null);
    try {
      await createApiClient(serverUrl).runRecurringJob(job.job_id, idempotency('run'));
      if (request !== identityRevision.current) return;
      Alert.alert('실행 요청을 접수했습니다', '저장된 작업 설정으로 요청했습니다. 실행 결과는 이력에서 확인하세요.');
    } catch (cause) { if (request === identityRevision.current) setError(errorMessage(cause)); } finally { if (request === identityRevision.current) setSaving(false); }
  };
  const archive = async () => {
    if (!job || saving) return;
    const request = identityRevision.current;
    setSaving(true); setError(null);
    try {
      await createApiClient(serverUrl).archiveRecurringJob(job.job_id, job.version);
      if (request === identityRevision.current) onDone(null);
    } catch (cause) { if (request === identityRevision.current) setError(errorMessage(cause)); } finally { if (request === identityRevision.current) setSaving(false); }
  };

  const currentDraft = { ...draft, prompt: promptDraft.value };
  const dirty = promptDraft.ready && JSON.stringify(currentDraft) !== JSON.stringify(job ? draftFromJob(job) : emptyDraft());
  const workspace = useSettingsSaveScope('recurring-jobs', {
    dirty, busy: saving || loading, canSave: promptDraft.ready && !loading && !job?.archived_at && (!jobId || Boolean(job)), save,
    discard: () => { setDraft(job ? draftFromJob(job) : emptyDraft()); promptDraft.clear(); setError(null); },
  });
  const saveScreen = workspace ? () => workspace.select('recurring-jobs') : undefined;
  const confirmArchive = () => { if (dirty) confirmSettingsDiscard(() => { promptDraft.clear(); void archive(); }, saveScreen); else void archive(); };
  const chooseNode = (nodeId: string) => {
    if (nodeId === draft.nodeId) return;
    const change = () => update({ nodeId, agentId: '', modelPreset: null });
    if (draft.agentId || draft.modelPreset) confirmSettingsDiscard(change, saveScreen); else change();
  };
  const Container = workspace ? View : ScrollView;
  const previewStyle = { gap: t.spacing.xs, padding: t.spacing.sm, borderRadius: t.foundation.radius.field, backgroundColor: t.colors.surfaceMuted };
  if (!serverUrl) return <Notice text="연결 설정을 저장하면 반복 작업을 편집할 수 있습니다." />;
  return <Container testID="recurring-job-editor" {...(workspace ? { style: styles.editor } : { contentContainerStyle: styles.editor, keyboardShouldPersistTaps: 'handled' as const })}>
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text>{jobId && !job ? <Action label="다시 불러오기" onPress={() => { if (dirty) confirmSettingsDiscard(() => void loadExisting(), saveScreen); else void loadExisting(); }}/>: null}</View> : null}
    <Text style={styles.heading}>{job ? job.name : '새 반복 작업'}</Text>
    <SettingsSection id="recurring-editor-groups" title="" flattened>
    <Group title="작업 내용">
    <Input label="작업 이름" value={draft.name} onChangeText={(name) => update({ name })} />
    <Input label="작업 내용" value={promptDraft.value} multiline editable={promptDraft.ready} onChangeText={promptDraft.setValue} />
    </Group>
    <Group title="일정">
    <Input label="시간대" value={draft.timezone} onChangeText={(timezone) => update({ timezone })} />
    <RecurringSchedulePicker value={draft.schedule} onChange={(schedule) => update({ schedule })} />
    <View style={styles.actions}><Action label="다음 5회" disabled={previewLoading} onPress={() => void previewSchedule()}/></View>
    {previewLoading ? <ActivityIndicator color={t.colors.accent}/> : null}
    {previewError ? <Text accessibilityRole="alert" style={styles.error}>{previewError}</Text> : null}
    {preview.length > 0 ? <View style={previewStyle}><Text style={styles.heading}>다음 5회</Text>{preview.map(time => <Text key={time} style={styles.help}>{formatTime(time, previewTimezone)}</Text>)}</View> : null}
    </Group>
    <Group title="실행 대상">
    {loadingTargets || loadingNodes ? <ActivityIndicator color={t.colors.accent}/> : null}
    {targetsError || nodesError ? <View><Text accessibilityRole="alert" style={styles.error}>{targetsError ?? nodesError}</Text><Action label="다시 시도" onPress={() => setTargetsReload(value => value + 1)}/></View> : null}
    <Text style={styles.label}>실행 노드</Text><OptionRow label="실행 노드" selected={draft.nodeId} options={nodes.map((node) => ({ id: node.nodeId, label: node.nodeId }))} onSelect={chooseNode} emptyLabel="연결된 노드 없음" />
    <Text style={styles.label}>실행 에이전트</Text><OptionRow label="실행 에이전트" selected={draft.agentId} options={agents.map((agent) => ({ id: agent.id, label: agent.name ?? agent.id }))} onSelect={(agentId) => update({ agentId })} emptyLabel="노드를 선택하세요" />
    <Text style={styles.label}>모델</Text><OptionRow label="모델" selected={draft.modelPreset ?? ''} options={[{ id: '', label: '에이전트 기본값' }, ...presets.map((preset) => ({ id: preset.id, label: preset.label, available: preset.available, reason: preset.reason_label }))]} onSelect={(modelPreset) => update({ modelPreset: modelPreset || null })} emptyLabel="에이전트 기본값" />
    <Text style={styles.label}>결과 폴더</Text><OptionRow label="결과 폴더" selected={draft.folderId} options={folders.map((folder) => ({ id: folder.id, label: folder.name }))} onSelect={(folderId) => update({ folderId })} emptyLabel="선택 가능한 폴더가 없습니다." />
    <Text style={styles.help}>선택한 폴더에 결과 세션을 저장합니다.</Text>
    </Group>
    <Group title="실행 방식">
    <Text style={styles.label}>생성·저장 후 자동 실행</Text><Switch accessibilityLabel="생성·저장 후 자동 실행" value={draft.enabled} onValueChange={enabled => update({ enabled })}/>
    <Input label="오프라인 허용 초" value={draft.lateRunWindowSeconds} keyboardType="number-pad" onChangeText={(lateRunWindowSeconds) => update({ lateRunWindowSeconds })} />
    {!workspace ? <Action label={saving ? '저장 중...' : '저장'} disabled={saving || loading || job?.archived_at != null || (Boolean(jobId) && !job)} primary onPress={() => void save()}/> : null}
    </Group></SettingsSection>
    {job ? <View style={styles.actions}><Action label="이력" disabled={saving} onPress={() => onOpenHistory(job.job_id)} testID="recurring-job-history" /><Action label={job.enabled ? '일시정지' : '재개'} disabled={saving || job.archived_at !== null} onPress={() => void updateEnabled()} testID="recurring-job-toggle-enabled" /><Action label="지금 실행" disabled={saving || job.archived_at !== null} primary onPress={() => void runNow()} testID="recurring-job-run-now" /><Action label="보관" disabled={saving || job.archived_at !== null} onPress={confirmArchive} testID="recurring-job-archive" /></View> : null}
  </Container>;
}

export function RecurringJobHistory({
  serverUrl,
  jobId,
  onOpenSession,
}: {
  serverUrl: string;
  jobId: string;
  onOpenSession(sessionId: string): void;
}) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<RecurringJobRunDto[]>([]);
  const requestRevision = useRef(0);
  useEffect(() => () => { ++requestRevision.current; }, [serverUrl, jobId]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++requestRevision.current;
    setLoading(true); setError(null);
    try {
      const result = await createApiClient(serverUrl).listRecurringJobRuns(jobId);
      if (request === requestRevision.current) setRuns(result.runs);
    } catch (cause) {
      if (request === requestRevision.current) setError(errorMessage(cause));
    } finally { if (request === requestRevision.current) setLoading(false); }
  }, [jobId, serverUrl]);
  useEffect(() => { void load(); }, [load]);
  return <View testID="recurring-job-history" style={styles.block}><View style={styles.headerRow}><Text style={styles.heading}>최근 실행</Text><Action label="새로고침" onPress={() => void load()} testID="recurring-job-history-refresh" /></View>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}{loading ? <ActivityIndicator color={t.colors.accent}/> : null}{!loading && !error && runs.length === 0 ? <Notice text="실행 이력이 없습니다." /> : !loading && !error && runs.map((run) => {
    const action = sessionAction(run);
    return <View key={run.run_id} style={styles.listRow}><View style={styles.grow}><Text style={styles.body}>{run.state}</Text><Text style={styles.help}>{formatTime(run.scheduled_for ?? run.created_at)}</Text>{run.reason_message || action.message ? <Text style={styles.help}>{run.reason_message ?? action.message}</Text> : null}</View><Action label={action.label} disabled={!action.canOpen} onPress={() => onOpenSession(run.session_id)} testID={`recurring-run-open-${run.run_id}`} /></View>;
  })}</View>;
}

function sessionAction(run: RecurringJobRunDto): { label: string; canOpen: boolean; message: string | null } {
  const noSessionState = new Set(['queued', 'waiting_for_node', 'skipped_overlap', 'skipped_late', 'cancelled']);
  const noSessionError = run.state === 'error' && (
    run.reason_code === 'RUN_SNAPSHOT_INVALID' ||
    run.reason_code === 'SESSION_DELETED' ||
    run.reason_code === 'CREATE_SESSION_BEFORE_SEND_FAILED'
  );
  if (noSessionState.has(run.state) || noSessionError) {
    return { label: '세션 없음', canOpen: false, message: '이 회차에는 열 수 있는 세션이 없습니다.' };
  }
  if (
    run.state === 'dispatching' ||
    run.state === 'awaiting_session' ||
    run.reason_code === 'CREATE_SESSION_REJECTED'
  ) {
    return { label: '고정 세션 열기', canOpen: true, message: null };
  }
  return { label: '세션 열기', canOpen: true, message: null };
}

function emptyDraft(): EditorDraft { return { name: '', prompt: '', timezone: 'Asia/Seoul', schedule: defaultRecurringSchedule(), nodeId: '', agentId: '', modelPreset: null, folderId: '', lateRunWindowSeconds: '1800', enabled: true }; }
function draftFromJob(job: RecurringJobDto): EditorDraft { return { name: job.name, prompt: job.prompt, timezone: job.timezone, schedule: recurringScheduleFromExpressions(job.schedule_expressions), nodeId: job.node_id, agentId: job.agent_id, modelPreset: job.model_preset, folderId: job.folder_id, lateRunWindowSeconds: String(job.late_run_window_seconds), enabled: job.enabled }; }
function writeFromDraft(draft: EditorDraft): RecurringJobWrite { const late = Number(draft.lateRunWindowSeconds); if (!Number.isSafeInteger(late) || late < 1) throw new Error('오프라인 허용 초는 1 이상의 정수여야 합니다.'); return { name: draft.name.trim(), prompt: draft.prompt.trim(), timezone: draft.timezone.trim(), schedule_expressions: recurringScheduleExpressions(draft.schedule), node_id: draft.nodeId.trim(), agent_id: draft.agentId.trim(), model_preset: draft.modelPreset, folder_id: draft.folderId.trim(), late_run_window_seconds: late, enabled: draft.enabled }; }
function formatTime(value: string | null, timeZone?: string): string { return value ? new Date(value).toLocaleString(undefined, timeZone ? { timeZone } : undefined) : '없음'; }
function idempotency(kind: string): string { return `recurring:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`; }
function errorMessage(cause: unknown): string {
  // Local form validation contains no remote payload or credentials.
  if (cause instanceof Error && !(cause instanceof ApiHttpError)) {
    const message = cause.message;
    if (message === '오프라인 허용 초는 1 이상의 정수여야 합니다.' || message.startsWith('요일을 ') || message.startsWith('매월 날짜을 ') || message.startsWith('실행 시각') || message.startsWith('고급 cron')) return message;
  }
  return safeErrorDetail(cause instanceof Error ? cause.message : String(cause));
}
function isVersionConflict(cause: unknown): cause is ApiHttpError { return cause instanceof ApiHttpError && cause.status === 409; }
