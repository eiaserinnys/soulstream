import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DashboardIconCap, LiquidGlassProvider, SwayCharacter, initTheme, useAuth, useDashboardStore, useInitialCatalogLoad, useSessionProvider, useUserPreferencesSync } from '@seosoyoung/soul-ui';
import { Eye, EyeOff } from 'lucide-react';
import { usePersistentSessionDetailsController } from '../components/PersistentSessionDetails';
import { usePersistentSessionGeometry } from './use-persistent-session-geometry';
import { navigateDashboard } from '../dashboard-navigation';
import { ConfigModal } from '../components/ConfigModal';
import { SettingsAlert, SettingsListRow } from '../components/config/SettingsListDetail';
import { createPersistentSessionsApi, type PersistentSession, type PersistentSessionList } from '../lib/persistent-sessions';
import { readPersistentSessionDevicePreferences, setPersistentSessionLastSessionId } from '../lib/persistent-session-device-preferences';
import { orchestratorSessionProvider } from '../providers';
import { useNodes } from '../hooks/useNodes';
import { useSessionNodeConnectivity } from './use-session-node-connectivity';
import { useV3LiveDataPlane } from './use-v3-live-data-plane';
import { resolveSessionForOpen } from './v3-session-workspace';
import { activateRunSession } from './folder-workspace-run-model';
import { PersistentSessionChatView } from './PersistentSessionChatView';
import { PersistentSessionSettingsDialog } from '../components/PersistentSessionSettingsDialog';
import { V3GlobalToolbar } from './V3GlobalToolbar';
import './v3-dashboard-styles';
import './persistent-session-screen.css';

export function PersistentSessionScreen({ sessionId }: { sessionId?: string }) {
  return <LiquidGlassProvider renderDefaultCanvas={false}><PersistentSessionContent sessionId={sessionId}/></LiquidGlassProvider>;
}

function PersistentSessionContent({ sessionId }: { sessionId?: string }) {
  const { user, refreshAuthStatus } = useAuth();
  const onConnectionError = useCallback(() => { void refreshAuthStatus().catch(() => undefined); }, [refreshAuthStatus]);
  useEffect(() => { initTheme(); }, []);
  useUserPreferencesSync(user?.email ?? null);
  useInitialCatalogLoad(true);
  useNodes(onConnectionError);
  const sessionIds = useMemo(() => sessionId ? [sessionId] : [], [sessionId]);
  useV3LiveDataPlane({ sessionIds, onConnectionError });
  const { nodes } = useSessionNodeConnectivity();
  const api = useMemo(() => createPersistentSessionsApi(), []);
  const [listing, setListing] = useState<PersistentSessionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const activeSessionKey = useDashboardStore(state => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore(state => state.activeSessionSummary);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const displaySettings = useDashboardStore(state => state.persistentSessionDisplaySettings);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => { const changed = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, []);
  const resource = listing?.sessions.find(session => session.session_id === sessionId) ?? null;
  const chatReady = Boolean(sessionId && activatedId === sessionId && activeSessionKey === sessionId);
  const geometry = usePersistentSessionGeometry({ app: appRef, header: headerRef, main: mainRef, composer: composerAnchorRef, enabled: chatReady, showCharacter: displaySettings?.showCharacter ?? false });
  const applySaved = useCallback((saved: PersistentSession) => {
    setListing(current => current ? { ...current, sessions: current.sessions.map(session => session.session_id === saved.session_id ? saved : session) } : current);
    useDashboardStore.getState().setPersistentSessionDisplaySettings(saved.session_id, saved.settings);
  }, []);
  const details = usePersistentSessionDetailsController({ resource, api, onSaved: applySaved });
  const stream = useSessionProvider({ sessionKey: chatReady ? activeSessionKey : null, getSessionProvider: () => orchestratorSessionProvider, active: chatReady, cursorScope: `${window.location.origin}|${user?.email ?? 'anonymous'}`, onConnectionError });
  useEffect(() => {
    let current = true;
    setLoading(true); setError(null); setActivatedId(null);
    void api.list().then(async result => {
      if (!current) return;
      setListing(result);
      if (!sessionId) {
        if (!result.sessions.length) setConfigOpen(true);
        else if (result.sessions.length === 1) navigateDashboard(`/persistent/${encodeURIComponent(result.sessions[0]!.session_id)}`, true);
        return;
      }
      if (!result.sessions.some(session => session.session_id === sessionId && session.persistent)) throw new Error('영구 세션을 찾을 수 없습니다.');
      const summary = await resolveSessionForOpen({ sessionId, fetchSessions: orchestratorSessionProvider.fetchSessions });
      if (!current) return;
      if (!summary) throw new Error('영구 세션의 대화를 불러오지 못했습니다.');
      activateRunSession(summary, useDashboardStore.getState());
      if (user?.email) setPersistentSessionLastSessionId(user.email, sessionId);
      setActivatedId(sessionId);
    }).catch(caught => { if (current) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, retry, sessionId, user?.email]);
  const disabled = !activeSessionSummary?.nodeId || nodes.get(activeSessionSummary.nodeId)?.status !== 'connected';
  const lastId = user?.email ? readPersistentSessionDevicePreferences(user.email).lastSessionId : null;
  return <div ref={appRef} className="v3-shell persistent-session-screen" data-testid="persistent-session-screen">
    <V3GlobalToolbar headerRef={headerRef} variant="minimal" sessionName={resource?.display_name ?? undefined} onOpenHome={() => navigateDashboard('/')} onOpenConfig={() => setSettingsOpen(true)}/>
    <main ref={mainRef} className="persistent-session-main">
      {loading ? <p role="status">불러오는 중…</p> : error ? <SettingsAlert>{error}<div className="flex gap-2"><Button data-testid="persistent-retry" onClick={() => setRetry(value => value + 1)}>다시 시도</Button><Button onClick={() => navigateDashboard('/')}>홈</Button><Button onClick={() => navigateDashboard('/persistent')}>세션 선택</Button></div></SettingsAlert> : !sessionId ? <div className="persistent-session-choices">{listing?.sessions.map(session => <div key={session.session_id} data-pas-choice={session.session_id}><SettingsListRow title={session.display_name ?? '영구 세션'} meta={session.agent_name ?? ''} selected={lastId === session.session_id} onSelect={() => navigateDashboard(`/persistent/${encodeURIComponent(session.session_id)}`)}/></div>)}</div> : null}
      {chatReady && !error && <PersistentSessionChatView key={sessionId} sessionId={sessionId!} presentation="manuscript" composerAnchorRef={composerAnchorRef} chatInputDisabled={disabled} fileUploadUrl={!disabled && activeSessionSummary?.nodeId ? `/api/attachments/sessions?nodeId=${encodeURIComponent(activeSessionSummary.nodeId)}` : undefined} historyEnabled={stream.synchronizedSessionKey === activeSessionKey}/>}
    </main>
    {geometry && <div aria-hidden="true" className="persistent-session-line" style={{ top: geometry.lineY, left: geometry.mainLeft - geometry.lineLeftReach, width: geometry.mainWidth + geometry.lineLeftReach }}/ >}
    {displaySettings && geometry?.body && <div data-testid="persistent-character" className="persistent-session-character" style={{ left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}><SwayCharacter shown width={geometry.body.width} height={geometry.body.height} motionEnabled={displaySettings.animateCharacter} active={visible && !settingsOpen} assetBaseUrl="/characters/seosoyoung"/></div>}
    {displaySettings && geometry?.toggle && <div className="persistent-session-character-toggle" style={{ left: geometry.toggle.left + geometry.toggle.width / 2, top: geometry.toggle.top + geometry.toggle.height / 2 }}><DashboardIconCap label="캐릭터 표시" aria-pressed={displaySettings.showCharacter} disabled={details.pending || !resource?.node_id} onClick={() => details.onFieldChange('showCharacter', !displaySettings.showCharacter, { saveImmediately: true })}>{displaySettings.showCharacter ? <Eye/> : <EyeOff/>}</DashboardIconCap></div>}
    {details.error && <div className="persistent-session-save-error"><SettingsAlert>{details.error}</SettingsAlert></div>}
    {settingsOpen && resource?.node_id && <PersistentSessionSettingsDialog sessionId={resource.session_id} nodeId={resource.node_id} onClose={() => setSettingsOpen(false)}/>}
    <ConfigModal open={configOpen} initialTab="persistent" onOpenChange={open => { setConfigOpen(open); if (!open) navigateDashboard('/'); }}/>
  </div>;
}
