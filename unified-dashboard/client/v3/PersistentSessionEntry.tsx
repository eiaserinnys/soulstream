import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardIconCap, Popover, PopoverPopup, PopoverTrigger, ProfileAvatar, useAgentPortraitUrlResolver, useAuth, useIsMobile } from '@seosoyoung/soul-ui';
import { ArrowLeftRight } from 'lucide-react';
import { navigateDashboard } from '../dashboard-navigation';
import { createPersistentSessionsApi, type PersistentSession, type PersistentSessionList } from '../lib/persistent-sessions';
import { readPersistentSessionDevicePreferences } from '../lib/persistent-session-device-preferences';
import { SettingsListRow } from '../components/config/SettingsListDetail';

export function persistentSessionPortrait(agentId: string | null | undefined, resolvePortrait: (agentId: string | null | undefined) => string) {
  return resolvePortrait(agentId) || null;
}

export function PersistentSessionChoiceRow({ session, selected, onSelect }: { session: PersistentSession; selected: boolean; onSelect(): void }) {
  const { t } = useTranslation();
  const resolvePortrait = useAgentPortraitUrlResolver();
  return <SettingsListRow title={session.display_name ?? t("persistent.session.title")} meta={session.agent_name ?? ''} selected={selected} portrait={<ProfileAvatar role="assistant" shape="circle" hasPortrait portraitUrl={persistentSessionPortrait(session.agent_id, resolvePortrait)} fallbackEmoji="🤖"/>} onSelect={onSelect}/>;
}

export function PersistentSessionSwitch({ sessions, currentSessionId }: { sessions: PersistentSession[]; currentSessionId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  if (sessions.length < 2) return null;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<DashboardIconCap ref={triggerRef} appearance="bare" label={t("persistent.session.switch")} data-testid="persistent-session-switch"/>}>
      <ArrowLeftRight className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
    </PopoverTrigger>
    <PopoverPopup align="end" anchor={isMobile ? triggerRef.current?.closest<HTMLElement>('.dashboard-toolbar-actions') ?? undefined : undefined} className="v3-popup-chrome"><div className="v3-surface">{sessions.map(session => <PersistentSessionChoiceRow key={session.session_id} session={session} selected={session.session_id === currentSessionId} onSelect={() => {
      setOpen(false);
      if (session.session_id !== currentSessionId) navigateDashboard(`/persistent/${encodeURIComponent(session.session_id)}`);
    }}/>)}</div></PopoverPopup>
  </Popover>;
}

/** Existing chrome cap and settings selection rows are the only home additions. */
export function PersistentSessionEntry() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  const api = useMemo(() => createPersistentSessionsApi(fetch, i18n.t), [i18n]);
  const [listing, setListing] = useState<PersistentSessionList | null>(null);
  const [open, setOpen] = useState(false);
  const entering = useRef(false);
  useEffect(() => { let current = true; void api.list().then(result => { if (current) setListing(result); }).catch(() => { /* Manual entry owns the existing error/retry surface. */ }); return () => { current = false; }; }, [api]);
  const lastId = user?.email ? readPersistentSessionDevicePreferences(user.email).lastSessionId : null;
  const portraitSession = listing?.sessions.find(session => session.session_id === lastId) ?? listing?.sessions[0];
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portrait = persistentSessionPortrait(portraitSession?.agent_id ?? listing?.create_defaults.preferred_agent_id, resolvePortrait);
  const enter = async () => {
    if (entering.current) return;
    entering.current = true;
    try {
      const current = await api.list();
      setListing(current);
      // 0개면 PAS 창이 빈 상태를 그린다.
      if (!current.sessions.length) navigateDashboard('/persistent');
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
      <PopoverTrigger render={<DashboardIconCap ref={triggerRef} label={t("persistent.session.open")} data-testid="persistent-session-entry" onClick={enter}/> }><ProfileAvatar role="assistant" shape="circle" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji="🤖"/></PopoverTrigger>
      <PopoverPopup align="end" anchor={isMobile ? triggerRef.current?.closest<HTMLElement>('.dashboard-toolbar-actions') ?? undefined : undefined} className="v3-popup-chrome"><div className="v3-surface">{listing?.sessions.map(session => <PersistentSessionChoiceRow key={session.session_id} session={session} selected={lastId === session.session_id} onSelect={() => { setOpen(false); navigateDashboard(`/persistent/${encodeURIComponent(session.session_id)}`); }}/>)}</div></PopoverPopup>
    </Popover>
  </>;
}
