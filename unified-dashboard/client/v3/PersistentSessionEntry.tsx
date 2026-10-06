import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardIconCap, Popover, PopoverPopup, PopoverTrigger, ProfileAvatar, useAuth } from '@seosoyoung/soul-ui';
import { navigateDashboard } from '../dashboard-navigation';
import { createPersistentSessionsApi, type PersistentSessionList } from '../lib/persistent-sessions';
import { readPersistentSessionDevicePreferences } from '../lib/persistent-session-device-preferences';
import { ConfigModal } from '../components/ConfigModal';
import { SettingsListRow } from '../components/config/SettingsListDetail';

export function persistentSessionPortrait(nodeId: string | null | undefined, agentId: string | null | undefined) {
  return nodeId && agentId ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait` : null;
}

/** Existing chrome cap and settings selection rows are the only home additions. */
export function PersistentSessionEntry() {
  const { user } = useAuth();
  const api = useMemo(() => createPersistentSessionsApi(), []);
  const [listing, setListing] = useState<PersistentSessionList | null>(null);
  const [open, setOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const entering = useRef(false);
  useEffect(() => { let current = true; void api.list().then(result => { if (current) setListing(result); }).catch(() => { /* Manual entry owns the existing error/retry surface. */ }); return () => { current = false; }; }, [api]);
  const lastId = user?.email ? readPersistentSessionDevicePreferences(user.email).lastSessionId : null;
  const portraitSession = listing?.sessions.find(session => session.session_id === lastId) ?? listing?.sessions[0];
  const portrait = persistentSessionPortrait(portraitSession?.node_id ?? listing?.create_defaults.node_id, portraitSession?.agent_id ?? listing?.create_defaults.preferred_agent_id);
  const enter = async () => {
    if (entering.current) return;
    entering.current = true;
    try {
      const current = await api.list();
      setListing(current);
      if (!current.sessions.length) setConfigOpen(true);
      else if (current.sessions.length === 1) navigateDashboard(`/persistent/${encodeURIComponent(current.sessions[0]!.session_id)}`);
      else setOpen(!open);
    } catch {
      navigateDashboard('/persistent');
    } finally {
      entering.current = false;
    }
  };
  return <>
    <Popover open={open} onOpenChange={next => { if (!next) setOpen(false); }}>
      <PopoverTrigger render={<DashboardIconCap label="영구 세션 열기" data-testid="persistent-session-entry" onClick={enter}/> }><ProfileAvatar role="assistant" shape="circle" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji="🤖"/></PopoverTrigger>
      <PopoverPopup align="end"><div className="v3-surface">{listing?.sessions.map(session => <SettingsListRow key={session.session_id} title={session.display_name ?? '영구 세션'} meta={session.agent_name ?? ''} selected={lastId === session.session_id} portrait={<ProfileAvatar role="assistant" hasPortrait shape="circle" portraitUrl={persistentSessionPortrait(session.node_id, session.agent_id)} fallbackEmoji="🤖"/>} onSelect={() => { setOpen(false); navigateDashboard(`/persistent/${encodeURIComponent(session.session_id)}`); }}/>)}</div></PopoverPopup>
    </Popover>
    <ConfigModal open={configOpen} onOpenChange={setConfigOpen} initialTab="persistent"/>
  </>;
}
