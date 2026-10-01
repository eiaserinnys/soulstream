import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
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
import { useTokens, type DesignTokens } from '../../theme';
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
  const styles = useMemo(() => makeStyles(t), [t]);
  const [jobs, setJobs] = useState<RecurringJobDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      setJobs((await createApiClient(serverUrl).listRecurringJobs(true)).jobs);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  if (!serverUrl) return <Notice text="연결 설정을 저장하면 반복 작업을 관리할 수 있습니다." />;
  return (
    <View testID="recurring-jobs-list" style={styles.block}>
      <View style={styles.headerRow}>
        <View style={styles.grow}><Text style={styles.heading}>반복 작업</Text><Text style={styles.help}>다음 실행 시각은 서버가 계산합니다.</Text></View>
        <View style={styles.actions}><Action label="새로고침" onPress={() => void load()} testID="recurring-jobs-refresh" /><Action label="새 작업" onPress={onCreate} /></View>
      </View>
      {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!loading && jobs.length === 0 ? <Notice text="등록된 반복 작업이 없습니다." /> : null}
      {jobs.map((job) => <TouchableOpacity key={job.job_id} testID={`recurring-job-${job.job_id}`} style={styles.jobRow} onPress={() => onEdit(job)} accessibilityRole="button"><View style={styles.grow}><Text style={styles.jobName}>{job.name}</Text><Text style={styles.help}>{job.archived_at ? '보관됨' : job.enabled ? `다음 실행 ${formatTime(job.next_run_at)}` : '일시정지됨'}</Text></View><Text style={styles.disclosure}>›</Text></TouchableOpacity>)}
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
  const styles = useMemo(() => makeStyles(t), [t]);
  const [job, setJob] = useState<RecurringJobDto | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft());
  const [nodes, setNodes] = useState<Array<{ nodeId: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string | null }>>([]);
  const [presets, setPresets] = useState<Array<{ id: string; label: string; available: boolean }>>([]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [preview, setPreview] = useState<string[]>([]);
  const [loading, setLoading] = useState(Boolean(jobId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    void createApiClient(serverUrl).listNodes().then((result) => {
      if (active) setNodes(result.nodes.map((node) => ({ nodeId: node.nodeId })));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [serverUrl]);
  const loadExisting = useCallback(async ({ preserveDraft = false }: { preserveDraft?: boolean } = {}) => {
    if (!serverUrl || !jobId) {
      setJob(null);
      if (!preserveDraft) setDraft(emptyDraft());
      setLoading(false);
      return true;
    }
    setLoading(true);
    try {
      const result = await createApiClient(serverUrl).listRecurringJobs(true);
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
      setError(errorMessage(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }, [jobId, serverUrl]);
  useEffect(() => { void loadExisting(); }, [loadExisting]);
  useEffect(() => {
    if (!serverUrl || !draft.nodeId) { setAgents([]); setPresets([]); return; }
    let active = true;
    const api = createApiClient(serverUrl);
    void Promise.all([api.listNodeAgents(draft.nodeId), api.listModelPresets(draft.nodeId)])
      .then(([agentResult, presetResult]) => {
        if (!active) return;
        setAgents(agentResult.agents);
        setPresets(presetResult.model_presets);
      })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [draft.nodeId, serverUrl]);

  const update = (patch: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const previewSchedule = async () => {
    setSaving(true); setError(null);
    try {
      const result = await createApiClient(serverUrl).previewRecurringSchedule({
        timezone: draft.timezone.trim(), schedule_expressions: recurringScheduleExpressions(draft.schedule),
      });
      setPreview(result.nextRuns);
    } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const write = writeFromDraft(draft);
      const api = createApiClient(serverUrl);
      const saved = job
        ? (await api.updateRecurringJob(job.job_id, { ...write, expected_version: job.version })).job
        : (await api.createRecurringJob({ ...write, idempotency_key: idempotency('create') })).job;
      setJob(saved); setDraft(draftFromJob(saved)); onDone(saved);
    } catch (cause) {
      if (isVersionConflict(cause) && job) {
        const refreshed = await loadExisting({ preserveDraft: true });
        setError(refreshed
          ? '다른 변경을 반영했습니다. 입력은 보존했습니다. 최신 버전으로 다시 저장하세요.'
          : '동시 수정은 감지됐지만 최신 버전을 불러오지 못했습니다. 입력은 보존했습니다. 새로고침 후 다시 저장하세요.');
      } else setError(errorMessage(cause));
    } finally { setSaving(false); }
  };
  const updateEnabled = async () => {
    if (!job) return;
    setSaving(true); setError(null);
    try {
      const saved = (await createApiClient(serverUrl).updateRecurringJob(job.job_id, {
        expected_version: job.version, enabled: !job.enabled,
      })).job;
      setJob(saved); setDraft(draftFromJob(saved)); onDone(saved);
    } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };
  const runNow = async () => {
    if (!job) return;
    setSaving(true); setError(null);
    try {
      await createApiClient(serverUrl).runRecurringJob(job.job_id, idempotency('run'));
      Alert.alert('실행 요청', '고정된 세션 ID로 실행 이력에 연결됩니다.');
    } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };
  const archive = async () => {
    if (!job) return;
    setSaving(true); setError(null);
    try {
      await createApiClient(serverUrl).archiveRecurringJob(job.job_id, job.version);
      onDone(null);
    } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };

  if (!serverUrl) return <Notice text="연결 설정을 저장하면 반복 작업을 편집할 수 있습니다." />;
  return <ScrollView testID="recurring-job-editor" contentContainerStyle={styles.editor} keyboardShouldPersistTaps="handled">
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Text style={styles.heading}>{job ? job.name : '새 반복 작업'}</Text>
    <Input label="작업 이름" value={draft.name} onChangeText={(name) => update({ name })} />
    <Input label="작업 내용" value={draft.prompt} multiline onChangeText={(prompt) => update({ prompt })} />
    <Input label="시간대" value={draft.timezone} onChangeText={(timezone) => update({ timezone })} />
    <RecurringSchedulePicker value={draft.schedule} onChange={(schedule) => update({ schedule })} />
    <Text style={styles.label}>생성·저장 후 자동 실행</Text><OptionRow selected={draft.enabled ? 'enabled' : 'paused'} options={[{ id: 'enabled', label: '실행' }, { id: 'paused', label: '일시정지' }]} onSelect={(state) => update({ enabled: state === 'enabled' })} emptyLabel="" />
    <Input label="오프라인 허용 초" value={draft.lateRunWindowSeconds} keyboardType="number-pad" onChangeText={(lateRunWindowSeconds) => update({ lateRunWindowSeconds })} />
    <Text style={styles.label}>실행 노드</Text><OptionRow selected={draft.nodeId} options={nodes.map((node) => ({ id: node.nodeId, label: node.nodeId }))} onSelect={(nodeId) => update({ nodeId, agentId: '', modelPreset: null })} emptyLabel="연결된 노드 없음" />
    <Text style={styles.label}>실행 에이전트</Text><OptionRow selected={draft.agentId} options={agents.map((agent) => ({ id: agent.id, label: agent.name ?? agent.id }))} onSelect={(agentId) => update({ agentId })} emptyLabel="노드를 선택하세요" />
    <Text style={styles.label}>모델</Text><OptionRow selected={draft.modelPreset ?? ''} options={[{ id: '', label: '에이전트 기본값' }, ...presets.map((preset) => ({ id: preset.id, label: preset.available ? preset.label : `${preset.label} (사용 불가)` }))]} onSelect={(modelPreset) => update({ modelPreset: modelPreset || null })} emptyLabel="에이전트 기본값" />
    <Text style={styles.label}>결과 폴더</Text><OptionRow selected={draft.folderId} options={folders.map((folder) => ({ id: folder.id, label: folder.name }))} onSelect={(folderId) => update({ folderId })} emptyLabel="선택 가능한 폴더가 없습니다." />
    <Text style={styles.help}>선택한 폴더에 결과 세션을 저장합니다.</Text>
    <View style={styles.actions}><Action label="다음 5회" disabled={saving} onPress={() => void previewSchedule()} /><Action label={saving ? '저장 중...' : '저장'} disabled={saving || job?.archived_at != null} primary onPress={() => void save()} /></View>
    {preview.length > 0 ? <View style={styles.preview}><Text style={styles.heading}>다음 5회</Text>{preview.map((time) => <Text key={time} style={styles.help}>{formatTime(time)}</Text>)}</View> : null}
    {job ? <View style={styles.actions}><Action label="이력" disabled={saving} onPress={() => onOpenHistory(job.job_id)} testID="recurring-job-history" /><Action label={job.enabled ? '일시정지' : '재개'} disabled={saving || job.archived_at !== null} onPress={() => void updateEnabled()} testID="recurring-job-toggle-enabled" /><Action label="지금 실행" disabled={saving || job.archived_at !== null} primary onPress={() => void runNow()} testID="recurring-job-run-now" /><Action label="보관" disabled={saving || job.archived_at !== null} onPress={() => void archive()} testID="recurring-job-archive" /></View> : null}
  </ScrollView>;
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
  const styles = useMemo(() => makeStyles(t), [t]);
  const [runs, setRuns] = useState<RecurringJobRunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns((await createApiClient(serverUrl).listRecurringJobRuns(jobId)).runs);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [jobId, serverUrl]);
  useEffect(() => { void load(); }, [load]);
  return <View testID="recurring-job-history" style={styles.block}><View style={styles.headerRow}><Text style={styles.heading}>최근 실행</Text><Action label="새로고침" onPress={() => void load()} testID="recurring-job-history-refresh" /></View>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}{runs.length === 0 ? <Notice text="실행 이력이 없습니다." /> : runs.map((run) => {
    const action = sessionAction(run);
    return <View key={run.run_id} style={styles.jobRow}><View style={styles.grow}><Text style={styles.jobName}>{run.state}</Text><Text style={styles.help}>{formatTime(run.scheduled_for ?? run.created_at)}</Text>{run.reason_message || action.message ? <Text style={styles.help}>{run.reason_message ?? action.message}</Text> : null}</View><Action label={action.label} disabled={!action.canOpen} onPress={() => onOpenSession(run.session_id)} testID={`recurring-run-open-${run.run_id}`} /></View>;
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

function Input({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]);
  return <View><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} style={[styles.input, props.multiline && styles.multiline]} placeholderTextColor={t.colors.textPlaceholder} {...props} /></View>;
}
function OptionRow({ selected, options, onSelect, emptyLabel }: { selected: string; options: Array<{ id: string; label: string }>; onSelect(value: string): void; emptyLabel: string }) {
  const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]);
  if (options.length === 0) return <Text style={styles.help}>{emptyLabel}</Text>;
  return <View style={styles.optionRow}>{options.map((option) => <TouchableOpacity key={option.id || 'default'} style={[styles.option, selected === option.id && styles.optionSelected]} onPress={() => onSelect(option.id)}><Text style={[styles.optionText, selected === option.id && styles.optionTextSelected]}>{option.label}</Text></TouchableOpacity>)}</View>;
}
function Action({ label, onPress, disabled, primary = false, testID }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean; testID?: string }) {
  const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]);
  return <TouchableOpacity testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.action, primary && styles.actionPrimary, disabled && styles.disabled]}><Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text></TouchableOpacity>;
}
function Notice({ text }: { text: string }) { const t = useTokens(); const styles = useMemo(() => makeStyles(t), [t]); return <Text style={styles.help}>{text}</Text>; }

function emptyDraft(): EditorDraft { return { name: '', prompt: '', timezone: 'Asia/Seoul', schedule: defaultRecurringSchedule(), nodeId: '', agentId: '', modelPreset: null, folderId: '', lateRunWindowSeconds: '1800', enabled: true }; }
function draftFromJob(job: RecurringJobDto): EditorDraft { return { name: job.name, prompt: job.prompt, timezone: job.timezone, schedule: recurringScheduleFromExpressions(job.schedule_expressions), nodeId: job.node_id, agentId: job.agent_id, modelPreset: job.model_preset, folderId: job.folder_id, lateRunWindowSeconds: String(job.late_run_window_seconds), enabled: job.enabled }; }
function writeFromDraft(draft: EditorDraft): RecurringJobWrite { const late = Number(draft.lateRunWindowSeconds); if (!Number.isSafeInteger(late) || late < 1) throw new Error('오프라인 허용 초는 1 이상의 정수여야 합니다.'); return { name: draft.name.trim(), prompt: draft.prompt.trim(), timezone: draft.timezone.trim(), schedule_expressions: recurringScheduleExpressions(draft.schedule), node_id: draft.nodeId.trim(), agent_id: draft.agentId.trim(), model_preset: draft.modelPreset, folder_id: draft.folderId.trim(), late_run_window_seconds: late, enabled: draft.enabled }; }
function formatTime(value: string | null): string { return value ? new Date(value).toLocaleString() : '없음'; }
function idempotency(kind: string): string { return `recurring:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`; }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function isVersionConflict(cause: unknown): cause is ApiHttpError { return cause instanceof ApiHttpError && cause.status === 409; }

function makeStyles(t: DesignTokens) { return StyleSheet.create({ block: { gap: t.spacing.sm }, editor: { paddingBottom: t.spacing.xl, gap: t.spacing.md }, headerRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }, grow: { flex: 1, minWidth: 0 }, heading: { ...t.foundation.typography.body, fontWeight: '700', color: t.colors.textPrimary }, label: { ...t.foundation.typography.meta, color: t.colors.textSecondary, marginBottom: t.spacing.xs }, help: { ...t.foundation.typography.meta, color: t.colors.textMuted }, error: { ...t.foundation.typography.meta, color: t.colors.error }, jobRow: { flexDirection: 'row', gap: t.spacing.sm, alignItems: 'center', minHeight: t.hitTarget.min, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border }, jobName: { ...t.foundation.typography.body, color: t.colors.textPrimary }, disclosure: { color: t.colors.textMuted, fontSize: t.iconSize.standard }, input: { minHeight: t.hitTarget.min, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, borderRadius: t.foundation.radius.field, color: t.colors.textPrimary, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, ...t.foundation.typography.body }, multiline: { minHeight: 92, textAlignVertical: 'top' }, optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs, marginBottom: t.spacing.sm }, option: { minHeight: t.hitTarget.min, minWidth: t.hitTarget.min, justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, borderRadius: t.foundation.radius.field, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs }, optionSelected: { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint }, optionText: { ...t.foundation.typography.meta, color: t.colors.textSecondary }, optionTextSelected: { color: t.colors.textPrimary, fontWeight: '700' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }, action: { minHeight: t.hitTarget.min, justifyContent: 'center', alignItems: 'center', paddingHorizontal: t.spacing.md, borderRadius: t.foundation.radius.field, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border }, actionPrimary: { backgroundColor: t.colors.accent, borderColor: t.colors.accent }, actionText: { ...t.foundation.typography.meta, color: t.colors.textPrimary, fontWeight: '700' }, actionTextPrimary: { color: t.colors.accentText }, disabled: { opacity: 0.45 }, preview: { gap: t.spacing.xs, padding: t.spacing.sm, borderRadius: t.foundation.radius.field, backgroundColor: t.colors.surfaceMuted } }); }
