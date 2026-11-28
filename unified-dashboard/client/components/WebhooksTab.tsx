import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPersistentSessionsApi, type PersistentSession } from '../lib/persistent-sessions';
import { createWebhooksApi, sessionName, type InboundWebhook, type OutboundSubscription } from '../lib/webhooks-api';
import { InboundWebhooksSection } from './InboundWebhooksSection';
import { OutboundWebhooksSection } from './OutboundWebhooksSection';
import './config/owned-agents.css';
import './config/access-links.css';
import './config/webhooks.css';

/**
 * 설정 창 「웹훅」 탭. 들어오는 웹훅과 나가는 웹훅을 위아래 두 구역으로 그린다.
 * 두 목록과 영구 세션 목록은 따로 읽는다. 하나가 실패해도 나머지 구역은 그대로 그린다.
 */
export function WebhooksTab({ request = fetch }: { request?: typeof fetch }) {
  const { t, i18n } = useTranslation();
  const api = useMemo(() => createWebhooksApi(request), [request]);
  const sessionsApi = useMemo(() => createPersistentSessionsApi(request, i18n.t), [i18n, request]);
  const alive = useRef(false);
  const [inbound, setInbound] = useState<InboundWebhook[] | null>(null);
  const [inboundError, setInboundError] = useState(false);
  const [outbound, setOutbound] = useState<OutboundSubscription[] | null>(null);
  const [outboundError, setOutboundError] = useState(false);
  const [sessions, setSessions] = useState<PersistentSession[]>([]);
  const [sessionsState, setSessionsState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadInbound = useCallback(async () => {
    setInboundError(false);
    try {
      const next = await api.listInbound();
      if (alive.current) setInbound(next);
    } catch {
      if (alive.current) { setInbound(null); setInboundError(true); }
    }
  }, [api]);
  const loadOutbound = useCallback(async () => {
    setOutboundError(false);
    try {
      const next = await api.listOutbound();
      if (alive.current) setOutbound(next);
    } catch {
      if (alive.current) { setOutbound(null); setOutboundError(true); }
    }
  }, [api]);
  const loadSessions = useCallback(async () => {
    try {
      const next = await sessionsApi.list();
      if (alive.current) { setSessions(next.sessions); setSessionsState('ready'); }
    } catch {
      if (alive.current) { setSessions([]); setSessionsState('error'); }
    }
  }, [sessionsApi]);

  useEffect(() => {
    alive.current = true;
    void Promise.allSettled([loadInbound(), loadOutbound(), loadSessions()]);
    return () => { alive.current = false; };
  }, [loadInbound, loadOutbound, loadSessions]);

  const names = new Map(sessions.map(session => [session.session_id, sessionName(session, t)]));
  return <div className="owned-agents webhooks">
    <InboundWebhooksSection api={api} items={inbound} error={inboundError} reload={loadInbound} names={names} sessions={sessions} sessionsState={sessionsState}/>
    <OutboundWebhooksSection api={api} items={outbound} error={outboundError} reload={loadOutbound} names={names} sessions={sessions} sessionsState={sessionsState}/>
  </div>;
}
