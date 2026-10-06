import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { createApiClient } from '../api/client';
import type { PersistentSessionCreateDefaults, PersistentSessionResource } from '../api/persistentSessionEndpoints';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { AppModalSurface } from '../components/AppModalSurface';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { GroupedGlassRow, GroupedGlassSheet } from '../components/planner/GroupedGlassSheet';
import { resolveSessionCardAvatar } from '../components/sessionCardDisplay';
import { resolvePersistentSessionEntry } from '../lib/persistent-session-entry';
import { SettingsScreen } from '../screens/SettingsScreen';
import { useAuthStore } from '../store/authStore';
import { createPersistentSessionScene, type PersistentSessionScene } from '../store/persistentSessionScene';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useTokens } from '../theme';
import { useAppNoticeStore } from '../store/appNoticeStore';

interface PersistentSessionHost {
  store: StoreApi<PersistentSessionScene>;
  portrait: Pick<PersistentSessionResource, 'session_id' | 'node_id' | 'agent_id' | 'agent_name'> | null;
  loading: boolean;
  requestEntry(onOpen: () => void, startup?: boolean): Promise<void>;
  initialize(onOpen: () => void, openOnStart: boolean): Promise<void>;
}
const Context = createContext<PersistentSessionHost | null>(null);

export function PersistentSessionProvider({ children, sessionIntent = false, onLeaveReady }: {
  children: React.ReactNode; sessionIntent?: boolean; onLeaveReady?: (leave: (() => void) | null) => void;
}) {
  const [store] = useState(createPersistentSessionScene);
  const t = useTokens();
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const jwt = useAuthStore(state => state.jwt);
  const email = decodeAuthJwt(jwt)?.email;
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl, jwt]);
  const [sessions, setSessions] = useState<PersistentSessionResource[]>([]);
  const [defaults, setDefaults] = useState<PersistentSessionCreateDefaults | null>(null);
  const [sheet, setSheet] = useState<'choose' | 'error' | 'add' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destination = useRef<() => void>(() => undefined);
  const pending = useRef<'manual' | 'startup' | null>(null);
  const intent = useRef(sessionIntent);
  intent.current = sessionIntent;
  React.useEffect(() => { if (sessionIntent) setSheet(null); }, [sessionIntent]);
  React.useLayoutEffect(() => {
    onLeaveReady?.(() => { store.getState().leave(); setSheet(null); pending.current = null; });
    return () => onLeaveReady?.(null);
  }, [store, onLeaveReady]);
  const last = useSettingsStore(state => state.getPersistentSessionDevicePreference(serverUrl, email).lastSessionId);
  const portrait = sessions.find(session => session.session_id === last) ?? sessions[0]
    ?? (defaults ? { session_id: '', node_id: defaults.node_id, agent_id: defaults.preferred_agent_id, agent_name: null } : null);

  function open(session: PersistentSessionResource) {
    store.getState().open(session);
    useSettingsStore.getState().setPersistentSessionLastSessionId(serverUrl, email, session.session_id);
    setSheet(null);
    destination.current();
  }
  async function readEntry(onOpen: () => void, mode: 'manual' | 'startup' | 'portrait') {
    if (mode !== 'portrait') {
      if (pending.current) return;
      destination.current = onOpen;
      pending.current = mode;
      setError(null);
      setLoading(true);
    }
    try {
      if (!api) throw new Error('서버에 연결해 주세요.');
      const result = await api.listPersistentSessions();
      setSessions(result.sessions); setDefaults(result.create_defaults);
      if (mode === 'portrait') return;
      if (pending.current !== mode) return;
      if (mode === 'startup' && intent.current) { setSheet(null); return; }
      const entry = resolvePersistentSessionEntry(result.sessions, last, mode === 'startup');
      if (entry.kind === 'open') open(entry.session);
      else setSheet(entry.kind === 'home' ? null : entry.kind);
    } catch {
      if (mode === 'startup') {
        setSheet(null);
        if (!intent.current) useAppNoticeStore.getState().showNotice({ tone: 'error', title: '영구 세션을 불러오지 못했습니다.', message: '입구에서 다시 시도해 주세요.' });
      } else if (mode === 'manual') { setError('영구 세션을 불러오지 못했습니다.'); setSheet('error'); }
    } finally { if (mode !== 'portrait') { pending.current = null; setLoading(false); } }
  }
  const requestEntry = (onOpen: () => void, startup = false) => readEntry(onOpen, startup ? 'startup' : 'manual');
  const initialize = (onOpen: () => void, openOnStart: boolean) => readEntry(onOpen, openOnStart ? 'startup' : 'portrait');
  const closeAdd = useRef<() => void>(() => setSheet(null));
  return <Context.Provider value={{ store, portrait, loading, requestEntry, initialize }}>
    {children}
    {sheet ? <AppModalSurface visible variant="expanded" presentationStyle="pageSheet" modalId="modal_settings" surfaceTestID="persistent-entry-sheet"
      onRequestClose={() => sheet === 'add' ? closeAdd.current() : setSheet(null)}>
      {sheet === 'add' ? <SettingsScreen category="persistent" initialPersistentDestination={{ kind: 'editor' }}
        onClose={() => setSheet(null)} registerCloseRequest={close => { closeAdd.current = close; }} />
        : <View style={{ flex: 1, padding: t.foundation.pageInset, gap: t.uiSpacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
            <Text style={{ flex: 1, ...t.foundation.typography.section, color: t.colors.textPrimary }}>영구 세션</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="영구 세션 선택 닫기" onPress={() => setSheet(null)}
              style={{ minHeight: t.hitTarget.min, minWidth: t.hitTarget.min, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ ...t.foundation.typography.body, color: t.colors.accent }}>닫기</Text>
            </TouchableOpacity>
          </View>
          {sheet === 'error' ? <>
            <Text testID="persistent-entry-error" style={{ ...t.foundation.typography.body, color: t.colors.errorText }}>{error}</Text>
            <LiquidGlassButton accessibilityLabel="영구 세션 다시 조회" onPress={() => void requestEntry(destination.current)}>
              <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text>
            </LiquidGlassButton>
          </> : null}
          {sheet === 'choose' ? <ScrollView showsVerticalScrollIndicator={false}>
            <GroupedGlassSheet>{sessions.map(session => <GroupedGlassRow key={session.session_id}
              testID={`persistent-entry-${session.session_id}`} selected={session.session_id === last}
              accessibilityLabel={session.display_name ?? session.session_id} onPress={() => open(session)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.md, padding: t.cardLayout.padding }}>
              <PersistentSessionPortrait session={session} size={t.avatarSize.message} />
              <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{session.display_name ?? session.session_id}</Text>
            </GroupedGlassRow>)}</GroupedGlassSheet>
          </ScrollView> : null}
        </View>}
    </AppModalSurface> : null}
  </Context.Provider>;
}

export function usePersistentSessionHost() {
  const host = useContext(Context);
  if (!host) throw new Error('PersistentSessionProvider가 필요합니다.');
  return host;
}
export function useOptionalPersistentSessionHost() {
  return useContext(Context);
}
export function usePersistentSessionScene<T>(selector: (state: PersistentSessionScene) => T) {
  return useStore(usePersistentSessionHost().store, selector);
}
export function PersistentSessionPortrait({ session, size }: {
  session: PersistentSessionHost['portrait']; size: number;
}) {
  const t = useTokens();
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const jwt = useAuthStore(state => state.jwt);
  const storedPortrait = useSessionStore(state => {
    if (!session) return null;
    return state.sessions[session.session_id]?.agentPortraitUrl
      ?? Object.values(state.sessions).find(item => item.nodeId === session.node_id && item.agentId === session.agent_id)?.agentPortraitUrl;
  });
  const avatar = resolveSessionCardAvatar({
    agentSessionId: session?.session_id ?? '', agentId: session?.agent_id,
    agentName: session?.agent_name, agentPortraitUrl: storedPortrait ?? (session?.agent_id && session.node_id
      ? `/api/nodes/${encodeURIComponent(session.node_id)}/agents/${encodeURIComponent(session.agent_id)}/portrait` : null),
  }, serverUrl);
  const style = { width: size, height: size, borderRadius: size / 2 };
  return avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={style} />
    : <View style={[style, { alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceMuted }]}>
      <Text style={{ ...t.foundation.typography.label, color: t.colors.textPrimary }}>{avatar.fallbackChar}</Text>
    </View>;
}
