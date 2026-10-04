import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { createApiClient } from '../../api/client';
import type { OwnedAgent, OwnedAgentKey, OwnedAgentsApi, OwnedAgentsResponse } from '../../api/ownedAgentsEndpoints';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { GlassButton } from '../GlassSurface';
import { SettingsDivider, SettingsSection } from './SettingsSection';

/** Owners unmount the panel or pass active=false when leaving its settings detail. */
export function OwnedAgentsSettingsSection({ flattened, api, serverUrl, active = true }: {
  flattened: boolean;
  api?: OwnedAgentsApi;
  serverUrl?: string;
  active?: boolean;
}) {
  const service = useMemo(() => api ?? (serverUrl ? createApiClient(serverUrl) : null), [api, serverUrl]);
  return active ? <OwnedAgentsPanel key={serverUrl} flattened={flattened} api={service} /> : null;
}

function OwnedAgentsPanel({ flattened, api }: { flattened: boolean; api: OwnedAgentsApi | null }) {
  const t = useTokens();
  const s = useMemo(() => makeStyles(t), [t]);
  const [data, setData] = useState<OwnedAgentsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const selection = useRef(selectedId); selection.current = selectedId;
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<{ agent: OwnedAgent; key: OwnedAgentKey } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!api) { setLoading(false); setError('서버 연결을 먼저 설정해 주세요.'); return; }
    setLoading(true); setError(null);
    try {
      const next = await api.listOwnedAgents();
      if (!alive.current) return;
      setData(next);
      setSelectedId(current => next.agents.some(a => a.id === current) ? current : next.agents[0]?.id ?? null);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { if (alive.current) setLoading(false); }
  }, [api]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  async function mutate(operation: () => Promise<void>, onError = setError) {
    if (inFlight.current || !api) return;
    inFlight.current = true; setBusy(true); onError(null);
    try { await operation(); } catch (cause) { if (alive.current) onError(message(cause)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function closeKey() { setToken(null); setCopied(false); setCopyError(false); }
  function action(label: string, onPress: () => void, disabled = busy, primary = false) {
    return <GlassButton accessibilityLabel={label} onPress={onPress} disabled={disabled} variant={primary ? 'primary' : 'secondary'} contentStyle={s.buttonContent}><Text style={primary ? s.primary : s.button}>{label}</Text></GlassButton>;
  }
  const existing = data?.existingConnection;
  return <SettingsSection id="owned-agents" title="내 에이전트" flattened={flattened}>
    <View style={s.block}>
      <Text style={s.body}>내 에이전트의 이름과 활성 상태, 연결 키를 관리합니다.</Text>
      {action('에이전트 추가', () => { setEditorError(null); setEditor({ id: null, name: '' }); }, busy || !api)}
      {loading && <ActivityIndicator accessibilityLabel="불러오는 중" color={t.colors.accent} />}
      {error && <><Text accessibilityRole="alert" style={s.error}>{error}</Text>{action('다시 시도', () => void load())}</>}
      {existing?.canRegister ? <><Text style={s.body}>현재 연결의 주소와 키를 그대로 사용해 내 에이전트로 등록합니다.</Text>{action('기존 연결 등록', () => void mutate(async () => { await api!.registerExistingOwnedAgent(); await load(); }))}</> : existing ? <Text style={s.body}>{existing.registered ? '기존 연결이 등록되어 있습니다.' : existing.configured ? '기존 연결 등록은 관리자에게 요청해 주세요.' : '등록할 기존 연결이 없습니다.'}</Text> : null}
      {data?.agents.length === 0 && <Text style={s.body}>아직 등록한 에이전트가 없습니다.</Text>}
    </View>
    {data?.agents.map(agent => <React.Fragment key={agent.id}>
      <SettingsDivider />
      <View style={s.block}>
        <View style={s.row}>
          <GlassButton accessibilityLabel={`선택 ${agent.name}`} style={s.nameButton} contentStyle={s.buttonContent} onPress={() => { closeKey(); selection.current = agent.id; setSelectedId(agent.id); }}><Text numberOfLines={1} style={s.name}>{agent.name}</Text></GlassButton>
          <Switch accessibilityLabel={`${agent.name} 활성화`} value={agent.enabled} disabled={busy} onValueChange={enabled => void mutate(async () => { await api!.updateOwnedAgent(agent.id, { enabled }); await load(); })}/>
          {action('이름 변경', () => { closeKey(); setEditorError(null); setEditor({ id: agent.id, name: agent.name }); })}
        </View>
        {selectedId === agent.id && <>
          <View style={s.row}><Text style={[s.heading, s.grow]}>연결 키</Text>{action(busy ? '처리 중…' : '새 키 발급', () => void mutate(async () => {
            const result = await api!.issueOwnedAgentKey(agent.id);
            if (alive.current && selection.current === agent.id) { setToken(result.token); setCopied(false); setCopyError(false); }
            await load();
          }))}</View>
          {!agent.keys.length && <Text style={s.body}>발급한 키가 없습니다.</Text>}
          {agent.keys.map(key => <View key={key.id} style={s.keyRow}>
            <View style={s.grow}><Text style={s.body}>{key.revokedAt ? '폐기됨' : '사용 가능'}{key.isExistingConnection ? ' · 기존 연결' : ''}</Text><Text style={s.meta}>생성 {date(key.createdAt)} · 최근 사용 {key.lastUsedAt ? date(key.lastUsedAt) : '없음'}</Text></View>
            {!key.revokedAt && action('키 폐기', () => { setRevokeError(null); setRevoking({ agent, key }); })}
          </View>)}
        </>}
      </View>
    </React.Fragment>)}
    {editor && <AppModalSurface visible modalId="modal_settings" variant="compact" onRequestClose={() => { if (!busy) setEditor(null); }}>
      <AppKeyboardAvoidingView style={s.modal} behavior={Platform.OS === 'ios' ? 'height' : undefined}>
      <ScrollView showsVerticalScrollIndicator={false} style={s.modal} keyboardShouldPersistTaps="handled"><View style={s.block}>
        <Text style={s.heading}>{editor.id ? '이름 변경' : '에이전트 추가'}</Text>
        <Text style={s.body}>설정에서 알아보기 쉬운 이름을 입력하세요.</Text>
        <TextInput accessibilityLabel="에이전트 이름" style={s.input} value={editor.name} onChangeText={name => setEditor(current => current && { ...current, name })} editable={!busy} autoCorrect={false}/>
        {editorError && <Text accessibilityRole="alert" style={s.error}>{editorError}</Text>}
        <View style={s.actions}>{action('취소', () => setEditor(null))}{action(busy ? '저장 중…' : '저장', () => void mutate(async () => {
          if (editor.id) await api!.updateOwnedAgent(editor.id, { name: editor.name.trim() }); else await api!.createOwnedAgent({ name: editor.name.trim() });
          if (alive.current) setEditor(null); await load();
        }, setEditorError), busy || !editor.name.trim(), true)}</View>
      </View></ScrollView>
      </AppKeyboardAvoidingView>
    </AppModalSurface>}
    {token !== null && <AppModalSurface visible modalId="modal_settings" variant="compact" onRequestClose={closeKey}>
      <ScrollView showsVerticalScrollIndicator={false} style={s.modal}><View style={s.block}>
        <Text style={s.heading}>새 연결 키</Text><Text style={s.body}>닫으면 다시 볼 수 없습니다. 지금 복사해 안전한 곳에 보관하세요.</Text>
        <Text selectable testID="owned-agent-token" style={s.body}>{token}</Text>
        {copyError && <Text accessibilityRole="alert" style={s.error}>복사하지 못했습니다. 다시 복사해 주세요.</Text>}
        <View style={s.actions}>{action('닫기', closeKey, false)}{action(copied ? '복사됨' : '복사', () => { const value = token; void Clipboard.setStringAsync(value).then(() => setCopied(true)).catch(() => setCopyError(true)); }, false, true)}</View>
      </View></ScrollView>
    </AppModalSurface>}
    {revoking && <AppModalSurface visible modalId="modal_settings" variant="compact" onRequestClose={() => { if (!busy) setRevoking(null); }}>
      <ScrollView showsVerticalScrollIndicator={false} style={s.modal}><View style={s.block}>
        <Text style={s.heading}>연결 키 폐기</Text><Text style={s.body}>{revoking.agent.name}의 이 키를 사용하는 연결은 더 이상 요청할 수 없습니다.</Text>
        {revokeError && <Text accessibilityRole="alert" style={s.error}>{revokeError}</Text>}
        <View style={s.actions}>{action('취소', () => setRevoking(null))}{action(busy ? '폐기 중…' : '폐기', () => void mutate(async () => {
          await api!.revokeOwnedAgentKey(revoking.agent.id, revoking.key.id); if (alive.current) setRevoking(null); await load();
        }, setRevokeError))}</View>
      </View></ScrollView>
    </AppModalSurface>}
  </SettingsSection>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.'; }
function date(value: string) { return new Date(value).toLocaleString(); }
function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { padding: t.cardLayout.padding, gap: t.spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    keyRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.spacing.sm },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: t.spacing.sm, flexWrap: 'wrap' },
    grow: { flex: 1, minWidth: 0 },
    nameButton: { flex: 1, minWidth: 0 },
    name: { ...t.foundation.typography.body, color: t.colors.textPrimary, flexShrink: 1 },
    body: { ...t.foundation.typography.body, color: t.colors.textPrimary },
    heading: { ...t.foundation.typography.section, color: t.colors.textPrimary },
    meta: { ...t.foundation.typography.meta, color: t.colors.textSecondary },
    error: { ...t.foundation.typography.body, color: t.colors.errorText },
    button: { ...t.foundation.typography.body, color: t.colors.link, fontWeight: '600' },
    primary: { ...t.foundation.typography.body, color: t.colors.accentText, fontWeight: '700' },
    buttonContent: { minHeight: t.foundation.minHeight.secondary },
    modal: { flexShrink: 1 },
    input: { ...t.foundation.typography.body, color: t.colors.textPrimary, minHeight: t.foundation.minHeight.field, padding: t.spacing.md, borderRadius: t.foundation.radius.field, backgroundColor: t.colors.surfaceMuted, borderColor: t.colors.border, borderWidth: StyleSheet.hairlineWidth },
  });
}
