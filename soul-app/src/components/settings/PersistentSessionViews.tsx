import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';

import {
  type PersistentSessionCreateDefaults,
  type PersistentSessionModel,
  type PersistentSessionModelWrite,
  type PersistentSessionResource,
} from '../../api/client';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import type { PersistentSessionSettingsPatch } from '../../api/persistentSessionEndpoints';
import { useSessionStore } from '../../store/sessionStore';
import { useChatStore } from '../../store/chatStore';
import { useTokens } from '../../theme';
import { describePersistentFailure } from './persistentSessionFailure';
import {
  SettingsAction as Action,
  SettingsFormGroup as Group,
  SettingsInput as Input,
  SettingsListHeader,
  SettingsListRow,
  SettingsNotice as Notice,
  SettingsReadOnlyField as ReadOnlyField,
  useSettingsFormStyles,
} from './SettingsFormParts';
import { SettingsOptionRow as OptionRow } from './SettingsOptionRow';
import { SettingsSection } from './SettingsSection';
import { useSettingsSaveScope } from './SettingsWorkspaceContext';
import {
  PersistentSessionSettingsFields,
  persistentSessionDisplayValues,
  type PersistentSessionDisplayField,
  type PersistentSessionEditorSection,
} from './PersistentSessionSettingsFields';
import { persistentChatDisplaySettings, savePersistentSessionSettings } from './persistentSessionSettingsActions';
import { usePersistentSessionApiFactory } from './persistentSessionApi';

const NO_MODEL = '모델 정보 없음';
const NO_PROFILE = '프로필 정보 없음';

export function PersistentSessionsList({
  serverUrl,
  onCreate,
  onEdit,
  refreshKey = 0,
}: {
  serverUrl: string;
  onCreate(): void;
  onEdit(session: PersistentSessionResource): void;
  /** Incremented after returning from the editor so the list is read again. */
  refreshKey?: number;
}) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  const createApi = usePersistentSessionApiFactory();
  const [sessions, setSessions] = useState<PersistentSessionResource[]>([]);
  const [loading, setLoading] = useState(Boolean(serverUrl));
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);
  useEffect(() => () => { ++requestRevision.current; }, [serverUrl]);
  const load = useCallback(async () => {
    const request = ++requestRevision.current;
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await createApi(serverUrl).listPersistentSessions();
      if (request === requestRevision.current) setSessions(result.sessions);
    } catch (cause) {
      if (request === requestRevision.current) setError(describePersistentFailure(cause, 'load').text);
    } finally {
      if (request === requestRevision.current) setLoading(false);
    }
  }, [serverUrl, createApi]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  if (!serverUrl) return <Notice text="연결 설정을 저장하면 영구 에이전트 세션을 관리할 수 있습니다." />;
  return (
    <View testID="persistent-sessions-list" style={styles.block}>
      <SettingsListHeader title="등록된 세션" help="상시 이어지는 세션을 관리합니다.">
        <Action label="새로고침" onPress={() => void load()} testID="persistent-sessions-refresh" />
        <Action label="새 세션" onPress={onCreate} testID="persistent-session-create" />
      </SettingsListHeader>
      {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
      {error ? <View style={styles.block}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Action label="다시 시도" onPress={() => void load()} testID="persistent-sessions-retry" /></View> : null}
      {!loading && !error && sessions.length === 0 ? <Notice text="등록된 영구 에이전트 세션이 없습니다." /> : null}
      {sessions.map((session) => <SettingsListRow
        key={session.session_id}
        testID={`persistent-session-${session.session_id}`}
        title={session.display_name ?? '이름 없음'}
        detail={`${session.agent_name ?? session.agent_id ?? NO_PROFILE} · ${session.runtime.current_model.model ?? session.runtime.current_model.model_preset ?? NO_MODEL}`}
        onPress={() => onEdit(session)}
      />)}
    </View>
  );
}

type Draft = { name: string; agentId: string; modelPreset: string; folderId: string; firstMessage: string; showCharacter: boolean; animateCharacter: boolean; showGenerationSeparator: boolean; showJevCandidates: boolean; showTurnUsage: boolean };
const emptyDraft = (): Draft => ({ name: '', agentId: '', modelPreset: '', folderId: '', firstMessage: '', showCharacter: true, animateCharacter: true, showGenerationSeparator: false, showJevCandidates: false, showTurnUsage: true });
const draftFromSession = (session: PersistentSessionResource): Draft => ({
  ...emptyDraft(), name: session.display_name ?? '', agentId: session.agent_id ?? '', modelPreset: session.settings.default_model.model_preset ?? '',
  showCharacter: session.settings.show_character !== false,
  animateCharacter: session.settings.animate_character !== false,
  showGenerationSeparator: session.settings.show_generation_separator === true,
  showJevCandidates: session.settings.show_jev_candidates === true,
  showTurnUsage: session.settings.show_turn_usage !== false,
});
const sameModel = (a: PersistentSessionModel, b: PersistentSessionModel) =>
  a.model_preset === b.model_preset && (a.reasoning_effort ?? null) === (b.reasoning_effort ?? null);

export function PersistentSessionEditor({
  serverUrl,
  sessionId,
  onDone,
  onRevealError,
  mode = 'workspace',
  section = 'all',
  nodeIdOverride,
  onSessionChange,
  onLoadStateChange,
  onPresetsChange,
  onDirtyChange,
}: {
  serverUrl: string;
  /** Without an id the editor adds a new session. */
  sessionId?: string;
  onDone(): void;
  /** Called when a failure is shown at the top, so the host can scroll it into view. */
  onRevealError?(): void;
  mode?: 'workspace' | 'pas';
  section?: PersistentSessionEditorSection;
  nodeIdOverride?: string;
  onSessionChange?(session: PersistentSessionResource | null): void;
  onLoadStateChange?(state: 'loading' | 'ready' | 'error'): void;
  onPresetsChange?(presets: ModelPresetAvailability[]): void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const t = useTokens();
  const styles = useSettingsFormStyles();
  const createApi = usePersistentSessionApiFactory();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [session, setSession] = useState<PersistentSessionResource | null>(null);
  const [defaults, setDefaults] = useState<PersistentSessionCreateDefaults | null>(null);
  const [baseline, setBaseline] = useState<Draft>(emptyDraft());
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [agents, setAgents] = useState<Array<{ id: string; name: string | null }>>([]);
  const [presets, setPresets] = useState<ModelPresetAvailability[]>([]);
  const [loading, setLoading] = useState(Boolean(serverUrl));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetsReload, setTargetsReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<{ sessionId: string; name: string } | null>(null);
  const [responseLost, setResponseLost] = useState(false);
  const nodeId = nodeIdOverride ?? session?.node_id ?? defaults?.node_id ?? '';
  // Without an owner node the server can neither list models nor save or release anything for this session.
  const nodeMissing = Boolean(session && !(nodeIdOverride ?? session.node_id));
  useEffect(() => { if (error || registration || responseLost) onRevealError?.(); }, [error, registration, responseLost]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onSessionChange?.(session); }, [session, onSessionChange]);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    onLoadStateChange?.('loading');
    setLoading(true); setLoadError(null);
    const api = createApi(serverUrl);
    let failed = false;
    void (async () => {
      try {
        if (sessionId) {
          const found = (await api.getPersistentSession(sessionId)).session;
          if (!active) return;
          setSession(found); setBaseline(draftFromSession(found)); setDraft(draftFromSession(found));
        } else {
          const loaded = (await api.listPersistentSessions()).create_defaults;
          if (active) setDefaults(loaded);
        }
      } catch (cause) {
        if (active) {
          failed = true;
          setLoadError(describePersistentFailure(cause, 'load').text);
        }
      } finally {
        if (active) {
          setLoading(false);
          onLoadStateChange?.(failed ? 'error' : 'ready');
        }
      }
    })();
    return () => { active = false; };
  }, [serverUrl, sessionId, reload, onLoadStateChange, createApi]);

  useEffect(() => {
    if (!serverUrl || !nodeId) return;
    let active = true;
    setLoadingTargets(true); setTargetsError(null);
    const api = createApi(serverUrl);
    void Promise.all([sessionId ? null : api.listNodeAgents(nodeId), api.listModelPresets(nodeId)])
      .then(([agentResult, presetResult]) => {
        if (!active) return;
        setPresets(presetResult.model_presets);
        onPresetsChange?.(presetResult.model_presets);
        if (agentResult) setAgents(agentResult.agents);
        if (!sessionId && defaults) {
          // The server's preferred values are used only when they really exist; nothing is substituted.
          const preferredAgent = defaults.preferred_agent_id;
          const agentId = agentResult?.agents.some((agent) => agent.id === preferredAgent) ? preferredAgent ?? '' : '';
          const preset = defaults.settings.default_model.model_preset;
          const modelPreset = preset && presetResult.model_presets.some((item) => item.id === preset && item.available) ? preset : '';
          setDraft((current) => ({ ...current, agentId: current.agentId || agentId, modelPreset: current.modelPreset || modelPreset }));
          setBaseline((current) => ({ ...current, agentId, modelPreset }));
        }
        setTargetsLoaded(true);
      })
      .catch(() => { if (active) setTargetsError('에이전트와 모델을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoadingTargets(false); });
    return () => { active = false; };
  }, [serverUrl, nodeId, sessionId, defaults, targetsReload, onPresetsChange, createApi]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const chooseModel = (id: string) => {
    if (id === draft.modelPreset) return;
    const preset = presets.find((item) => item.id === id);
    if (preset && !preset.available) {
      setModelError(`${preset.label}은(는) 지금 선택할 수 없습니다${preset.reason_label ? `: ${preset.reason_label}` : '.'}`);
      return;
    }
    setModelError(null);
    update({ modelPreset: id });
  };
  // The effort is not an input: keep the recorded one for an unchanged choice, use the catalog default for a new one.
  const modelWrite = (): PersistentSessionModelWrite => {
    const recorded = (session?.settings ?? defaults?.settings)?.default_model;
    const effort = recorded && recorded.model_preset === draft.modelPreset
      ? recorded.reasoning_effort ?? null
      : presets.find((item) => item.id === draft.modelPreset)?.default_effort ?? null;
    return { model_preset: draft.modelPreset, reasoning_effort: effort };
  };

  const loaded = Boolean(session ?? defaults);
  const dirty = loaded && JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => { onDirtyChange?.(mode === 'pas' && dirty); }, [dirty, mode, onDirtyChange]);
  // After a lost create answer the session may already exist; adding again would make a second one.
  const canSave = loaded && !loading && !loadError && !responseLost && !nodeMissing && Boolean(draft.name.trim() && draft.modelPreset)
    && (Boolean(session) || (Boolean(draft.agentId && draft.folderId) && !loadingTargets));
  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true); setError(null); setResponseLost(false);
    const name = draft.name.trim();
    const defaultModel = modelWrite();
    try {
      const api = createApi(serverUrl);
      let saved: PersistentSessionResource | null = null;
      if (session) {
        const settings: PersistentSessionSettingsPatch = { default_model: defaultModel };
        if (draft.showCharacter !== baseline.showCharacter) settings.show_character = draft.showCharacter;
        if (draft.animateCharacter !== baseline.animateCharacter) settings.animate_character = draft.animateCharacter;
        if (draft.showGenerationSeparator !== baseline.showGenerationSeparator) {
          settings.show_generation_separator = draft.showGenerationSeparator;
        }
        if (draft.showJevCandidates !== baseline.showJevCandidates) {
          settings.show_jev_candidates = draft.showJevCandidates;
        }
        if (draft.showTurnUsage !== baseline.showTurnUsage) settings.show_turn_usage = draft.showTurnUsage;
        saved = await savePersistentSessionSettings(api, session.session_id, settings, name);
      }
      else if (registration) await api.updatePersistentSession(registration.sessionId, { display_name: name, enabled: true, settings: { default_model: defaultModel } });
      else await api.createPersistentSession({ display_name: name, agent_id: draft.agentId, folder_id: draft.folderId, initial_instruction: draft.firstMessage.trim(), settings: { default_model: defaultModel } });
      if (saved && saved.persistent) useChatStore.getState().applyPersistentDisplaySettings(session!.session_id, persistentChatDisplaySettings(saved));
      if (mounted.current) {
        if (mode === 'pas' && saved) {
          const next = draftFromSession(saved);
          setSession(saved); setDraft(next); setBaseline(next);
        } else onDone();
      }
    } catch (cause) {
      if (!mounted.current) return;
      const failure = describePersistentFailure(cause, session || registration ? 'save' : 'create');
      setResponseLost(failure.responseLost);
      if (failure.createdSession) setRegistration({ sessionId: failure.createdSession.session_id, name: failure.createdSession.display_name ?? name });
      else if (!failure.responseLost) setError(failure.text); // a lost answer is explained by its own notice below
    } finally { if (mounted.current) setSaving(false); }
  };
  const release = async () => {
    if (!session || saving) return;
    setSaving(true); setError(null);
    try {
      await createApi(serverUrl).updatePersistentSession(session.session_id, { enabled: false });
      if (mounted.current) onDone();
    } catch (cause) {
      if (mounted.current) setError(describePersistentFailure(cause, 'release').text);
    } finally { if (mounted.current) setSaving(false); }
  };
  const confirmRelease = () => Alert.alert(
    '영구 세션 해제',
    '영구 세션을 해제할까요? 세션과 대화 기록은 남습니다.',
    [
      { text: '취소', style: 'cancel' },
      { text: '해제', style: 'destructive', onPress: () => void release() },
    ],
  );
  useSettingsSaveScope('persistent', {
    dirty, busy: saving || loading, canSave,
    saveLabel: sessionId ? '저장' : registration ? '등록 다시 시도' : '세션 추가',
    save,
    discard: () => { setDraft(baseline); setError(null); setModelError(null); },
  });

  if (!serverUrl) return <Notice text="연결 설정을 저장하면 영구 에이전트 세션을 편집할 수 있습니다." />;
  const current = session?.runtime.current_model;
  const pending = session?.runtime.pending ?? null;
  const recorded = session?.settings.default_model;
  const needsResave = Boolean(session && recorded?.model_preset && current && !sameModel(recorded, current)
    && !(pending && sameModel(recorded, { model_preset: pending.target_model_preset, reasoning_effort: pending.target_reasoning_effort })));
  const defaultsNotice = !session && defaults
    ? defaults.unavailable_reason ?? (targetsLoaded && (!baseline.agentId || !baseline.modelPreset) ? '기본 프로필이나 기본 모델을 지금 쓸 수 없습니다. 목록에서 골라 주세요.' : null)
    : null;
  const sessionDisplay = session ? persistentSessionDisplayValues(session) : null;
  const displayChange = (field: PersistentSessionDisplayField, value: boolean) => {
    const draftField: Record<PersistentSessionDisplayField, keyof Draft> = {
      show_character: 'showCharacter', animate_character: 'animateCharacter',
      show_generation_separator: 'showGenerationSeparator', show_jev_candidates: 'showJevCandidates', show_turn_usage: 'showTurnUsage',
    };
    if (mode !== 'pas') { update({ [draftField[field]]: value }); return; }
    if (!session || saving) return;
    setSaving(true); setError(null);
    void savePersistentSessionSettings(createApi(serverUrl), session.session_id, { [field]: value })
      .then((saved) => {
        if (!mounted.current) return;
        const next = draftFromSession(saved);
        setSession(saved);
        setDraft((current) => ({
          ...current,
          showCharacter: next.showCharacter,
          animateCharacter: next.animateCharacter,
          showGenerationSeparator: next.showGenerationSeparator,
          showJevCandidates: next.showJevCandidates,
          showTurnUsage: next.showTurnUsage,
        }));
        setBaseline((current) => ({
          ...current,
          showCharacter: next.showCharacter,
          animateCharacter: next.animateCharacter,
          showGenerationSeparator: next.showGenerationSeparator,
          showJevCandidates: next.showJevCandidates,
          showTurnUsage: next.showTurnUsage,
        }));
        if (saved.persistent) useChatStore.getState().applyPersistentDisplaySettings(saved.session_id, persistentChatDisplaySettings(saved));
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(describePersistentFailure(cause, 'save').text);
      })
      .finally(() => { if (mounted.current) setSaving(false); });
  };
  return <View testID={mode === 'pas' ? 'persistent-session-pas-editor' : 'persistent-session-editor'} style={styles.editor}>
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {mode === 'pas' && saving ? <ActivityIndicator accessibilityLabel="저장 중" color={t.colors.accent} /> : null}
    {loadError ? <View style={styles.block}><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text><Action label="다시 불러오기" onPress={() => setReload((value) => value + 1)} testID="persistent-session-reload" /></View> : null}
    {loaded && mode === 'workspace' ? <Text style={styles.heading}>{session ? session.display_name ?? '이름 없음' : '새 영구 에이전트 세션'}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {registration ? <View style={styles.block}>
      <Text accessibilityRole="alert" style={styles.error}>세션은 만들어졌으나 등록하지 못했습니다. ({registration.name})</Text>
      <Action label="등록 다시 시도" disabled={saving || !canSave} onPress={() => void save()} testID="persistent-registration-retry" />
    </View> : null}
    {responseLost ? <View style={styles.block}>
      <Text style={styles.help}>응답을 받지 못했습니다. 세션이 일반 세션으로 만들어졌을 수 있으니 기존 세션 목록에서 확인해 주세요.</Text>
      <Action label="목록 다시 읽기" onPress={onDone} testID="persistent-session-reread" />
    </View> : null}
    {session && sessionDisplay ? <PersistentSessionSettingsFields
      section={mode === 'pas' ? section : 'all'}
      session={session}
      name={draft.name}
      onNameChange={(name) => update({ name })}
      modelPreset={draft.modelPreset}
      onModelChange={chooseModel}
      presets={presets}
      display={mode === 'pas' ? sessionDisplay : {
        show_character: draft.showCharacter,
        animate_character: draft.animateCharacter,
        show_generation_separator: draft.showGenerationSeparator,
        show_jev_candidates: draft.showJevCandidates,
        show_turn_usage: draft.showTurnUsage,
      }}
      displaySaving={saving}
      onDisplayChange={displayChange}
      loadingTargets={loadingTargets}
      targetsError={targetsError}
      onRetryTargets={() => setTargetsReload((value) => value + 1)}
      modelError={modelError}
      defaultsNotice={defaultsNotice}
      nodeMissing={nodeMissing}
      needsResave={needsResave}
    /> : null}
    {!session && defaults && loaded ? <SettingsSection id="persistent-editor-groups" title="" flattened>
      <Group title="세션 설정">
        <Input label="세션 이름" value={draft.name} onChangeText={(name) => update({ name })} />
        {defaults ? <ReadOnlyField label="실행 노드" value={defaults.node_id} /> : null}
        {loadingTargets ? <ActivityIndicator color={t.colors.accent} /> : null}
        {nodeMissing ? <Text accessibilityRole="alert" style={styles.error}>이 세션의 노드를 알 수 없어 편집할 수 없습니다.</Text> : null}
        {targetsError ? <View style={styles.block}><Text accessibilityRole="alert" style={styles.error}>{targetsError}</Text><Action label="다시 시도" onPress={() => setTargetsReload((value) => value + 1)} testID="persistent-targets-retry" /></View> : null}
        {defaultsNotice ? <Notice text={defaultsNotice} /> : null}
        <Text style={styles.label}>프로필</Text>
        <OptionRow label="프로필" selected={draft.agentId} options={agents.map((agent) => ({ id: agent.id, label: agent.name ?? agent.id }))} onSelect={(agentId) => update({ agentId })} emptyLabel="선택 가능한 프로필이 없습니다." />
        <Text style={styles.label}>기본 모델</Text>
        <OptionRow label="기본 모델" selected={draft.modelPreset} options={presets.map((preset) => ({ id: preset.id, label: preset.label, available: preset.available, reason: preset.reason_label }))} onSelect={chooseModel} emptyLabel="선택 가능한 모델이 없습니다." />
        {modelError ? <Text accessibilityRole="alert" style={styles.error}>{modelError}</Text> : null}
        {!draft.modelPreset && !loadingTargets ? <Notice text="기본 모델을 선택해야 저장할 수 있습니다." /> : null}
      </Group>
      {defaults ? <Group title="시작">
        <Text style={styles.label}>결과 폴더</Text>
        <OptionRow label="폴더" selected={draft.folderId} options={folders.map((folder) => ({ id: folder.id, label: folder.name }))} onSelect={(folderId) => update({ folderId })} emptyLabel="선택 가능한 폴더가 없습니다." />
        <Input label="첫 메시지 (선택)" value={draft.firstMessage} multiline onChangeText={(firstMessage) => update({ firstMessage })} />
        <Text style={styles.help}>비워 두면 서버가 정한 문장으로 시작합니다: {defaults.initial_instruction}</Text>
      </Group> : null}
    </SettingsSection> : null}
    {mode === 'pas' && session && section === 'account-model' ? <View style={styles.block}>
      <View style={styles.actions}><Action label={saving ? '저장 중…' : '저장'} primary disabled={saving || loading || !canSave || !dirty} onPress={() => void save()} testID="persistent-pas-settings-save" /></View>
    </View> : null}
    {mode === 'workspace' && session ? <View style={styles.block}>
      <View style={styles.actions}><Action label="영구 세션 해제" disabled={saving || loading || nodeMissing} onPress={confirmRelease} testID="persistent-session-release" /></View>
      <Text style={styles.help}>해제해도 세션과 대화 기록은 남습니다.</Text>
    </View> : null}
  </View>;
}
