import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Input } from '@seosoyoung/soul-ui';
import { accessLinkStatus, AccessLinksError, createAccessLinksApi, type AccessLink, type AccessLinkPermission } from '../lib/access-links-api';
import { createPersistentSessionsApi, type PersistentSession } from '../lib/persistent-sessions';
import { formatStamp, sessionName, sessionShortName, type WebhookTranslate } from '../lib/webhooks-api';
import { CatalogSelectionField } from './CatalogSelectionField';
import { busyButtonClassName } from './config/busy-button';
import { SettingsAlert, SettingsField } from './config/SettingsListDetail';
import './config/owned-agents.css';
import './config/access-links.css';

const manual = 'manual';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function lastUsed(value: string | null, locale: string, t: WebhookTranslate) {
  if (!value) return t('webhooks.access.neverUsed');
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 60) return t('webhooks.access.usedMinutes', { count: minutes });
  if (minutes < 1440) return t('webhooks.access.usedHours', { count: Math.floor(minutes / 60) });
  if (minutes < 2880) return t('webhooks.access.usedYesterday');
  if (minutes < 10080) return t('webhooks.access.usedDays', { count: Math.floor(minutes / 1440) });
  return t('webhooks.access.usedDate', { date: formatStamp(value, locale) });
}
function issueError(cause: unknown, t: WebhookTranslate) {
  const status = cause instanceof AccessLinksError ? cause.status : 0;
  if (status === 401) return t('webhooks.common.relogin');
  if (status === 422) return t('webhooks.common.checkInput');
  return t('webhooks.access.createError');
}

export function AccessLinksTab({ request = fetch }: { request?: typeof fetch }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const permissions: { value: AccessLinkPermission; label: string; description?: string }[] = [
    { value: 'send', label: t('webhooks.access.send') },
    { value: 'read_own', label: t('webhooks.access.readOwn'), description: t('webhooks.access.readOwnHelp') },
    { value: 'read_history', label: t('webhooks.access.readHistory'), description: t('webhooks.access.readHistoryHelp') },
    { value: 'control', label: t('webhooks.access.control') },
  ];
  const durations = [{ value: '3600', label: t('webhooks.common.oneHour') }, { value: '86400', label: t('webhooks.common.oneDay') }, { value: '604800', label: t('webhooks.common.sevenDays') }, { value: '2592000', label: t('webhooks.common.thirtyDays') }];
  const api = useMemo(() => createAccessLinksApi(request), [request]);
  const sessionsApi = useMemo(() => createPersistentSessionsApi(request, i18n.t), [i18n, request]);
  const [links, setLinks] = useState<AccessLink[] | null>(null);
  const [sessions, setSessions] = useState<PersistentSession[]>([]);
  const [sessionsState, setSessionsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState(false);
  const [editor, setEditor] = useState(false);
  const [target, setTarget] = useState('');
  const [manualId, setManualId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [label, setLabel] = useState('');
  const [duration, setDuration] = useState('86400');
  const [selected, setSelected] = useState<AccessLinkPermission[]>(['send', 'read_own']);
  const [targetError, setTargetError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<AccessLink | null>(null);
  const [revokeError, setRevokeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const focusManual = useRef(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const cancelRevoke = useRef<HTMLButtonElement>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnRevokeFocus = useRef('');
  const load = useCallback(async () => {
    setListError(false);
    const [listResult, sessionsResult] = await Promise.allSettled([api.list(), sessionsApi.list()]);
    if (!alive.current) return;
    if (listResult.status === 'fulfilled') setLinks(listResult.value); else { setLinks(null); setListError(true); }
    if (sessionsResult.status === 'fulfilled') { setSessions(sessionsResult.value.sessions); setSessionsState('ready'); }
    else { setSessions([]); setSessionsState('error'); }
  }, [api, sessionsApi]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  useEffect(() => { if (editor && url) copyButton.current?.focus(); }, [editor, url]);
  function openEditor() {
    setTarget(''); setManualId(''); setIdTouched(false); setLabel(''); setDuration('86400'); setSelected(['send', 'read_own']);
    setError(null); setTargetError(false); setUrl(null); setCopied(false); setCopyError(false); setEditor(true);
  }
  function closeEditor() { setEditor(false); }
  const active = links?.filter(link => accessLinkStatus(link) === 'active') ?? [];
  const past = links?.filter(link => accessLinkStatus(link) !== 'active') ?? [];
  const names = new Map(sessions.map(session => [session.session_id, sessionName(session, t)]));
  async function issue() {
    const id = target === manual ? manualId.trim() : target;
    if (inFlight.current || !id || !label.trim() || !selected.length) return;
    if (target === manual && !uuid.test(id)) { setIdTouched(true); return; }
    inFlight.current = true; setBusy(true); setError(null); setTargetError(false);
    try {
      const result = await api.issue({ target_session_id: id, label: label.trim(), permissions: selected, expires_in_seconds: Number(duration) });
      if (alive.current) { setUrl(result.url); void load(); }
    } catch (cause) {
      if (alive.current) { if (cause instanceof AccessLinksError && cause.status === 404) setTargetError(true); else setError(issueError(cause, t)); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function revoke() {
    if (!revoking || inFlight.current) return;
    const id = revoking.id;
    const index = active.findIndex(link => link.id === id);
    const nextId = active[index + 1]?.id ?? active[index - 1]?.id ?? '';
    inFlight.current = true; setBusy(true); setRevokeError(false);
    try {
      try { await api.revoke(id); } catch (cause) { if (!(cause instanceof AccessLinksError && cause.status === 404)) throw cause; }
      if (alive.current) { await load(); returnRevokeFocus.current = nextId; setRevoking(null); }
    } catch { if (alive.current) setRevokeError(true); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  const row = (link: AccessLink, isPast: boolean) => {
    const status = accessLinkStatus(link);
    return <div className={`owned-agents-block access-links-row${isPast ? ' is-past' : ''}`} key={link.id}>
      <div className="owned-agents-key-row"><div className="access-links-copy">
        <p className="access-links-label" title={link.label} data-v3-selectable-content="true">{link.label}</p>
        <div className="owned-agents-meta access-links-meta" data-v3-selectable-content="true">
          {isPast && <span>{t(status === 'revoked' ? 'webhooks.common.revokedAt' : 'webhooks.common.expiredAt', { date: formatStamp(status === 'revoked' ? link.revoked_at! : link.expires_at, locale) })}</span>}
          <span>{names.get(link.target_session_id) ?? sessionShortName(link.target_session_id, t)}</span>
          <span>{link.permissions.map(p => permissions.find(item => item.value === p)?.label ?? p).join(', ')}</span>
          {!isPast && <span>{t('webhooks.common.expiresAt', { date: formatStamp(link.expires_at, locale, true) })}</span>}
          <span>{lastUsed(link.last_used_at, locale, t)}</span>
        </div>
      </div>{!isPast && <Button ref={el => { if (el) revokeButtons.current.set(link.id, el); else revokeButtons.current.delete(link.id); }} variant="outline" disabled={busy} onClick={() => { setRevokeError(false); setRevoking(link); requestAnimationFrame(() => cancelRevoke.current?.focus()); }}>{t('webhooks.common.revoke')}</Button>}</div>
    </div>;
  };
  return <div className="owned-agents access-links">
    <div className="owned-agents-actions"><Button ref={createButton} onClick={openEditor}>{t('webhooks.access.create')}</Button></div>
    {listError ? <div className="space-y-2"><SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.access.loadError')}</span></SettingsAlert><Button variant="outline" onClick={() => { setLinks(null); void load(); }}>{t('webhooks.common.retry')}</Button></div>
      : links === null ? <div role="status" aria-label={t('webhooks.common.loading')}>{[0, 1].map(i => <div className="owned-agents-block" key={i}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
      : <>{links.length === 0 ? <p className="access-links-empty">{t('webhooks.access.empty')}</p> : <>{active.length ? active.map(link => row(link, false)) : <p className="access-links-empty">{t('webhooks.access.noActive')}</p>}{past.length > 0 && <details className="config-advanced"><summary>{t('webhooks.access.past')}{' '}<span>{past.length}</span></summary>{past.map(link => row(link, true))}</details>}</>}</>}
    <Dialog open={editor} onOpenChange={open => { if (!open && !busy) closeEditor(); }} onOpenChangeComplete={open => { if (!open && !editor) { setUrl(null); createButton.current?.focus(); } }}>
        <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={targetButton} finalFocus={createButton}>
        <DialogHeader><DialogTitle>{url ? t('webhooks.access.created') : t('webhooks.access.createTitle')}</DialogTitle><DialogDescription>{url ? t('webhooks.access.urlOnce') : t('webhooks.access.createHelp')}</DialogDescription></DialogHeader>
        {url ? <DialogPanel><p className="owned-agents-token" data-v3-selectable-content="true">{url}</p><p className="access-links-hint" data-v3-selectable-content="true">{t('webhooks.access.shareHelp')}</p>{copyError && <SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.access.copyError')}</span></SettingsAlert>}</DialogPanel>
          : <DialogPanel className="access-links-form">
            <div><CatalogSelectionField className="access-links-field" label={t('webhooks.common.targetSession')} ariaLabel={t('webhooks.common.targetSession')} triggerRef={targetButton} triggerClassName={!target ? 'text-muted-foreground' : undefined} value={target} selectedLabel={sessionsState === 'loading' ? t('webhooks.common.loadingProgress') : target === manual ? t('webhooks.common.manualSessionId') : names.get(target) ?? t('webhooks.common.selectSession')} disabled={busy || sessionsState === 'loading'} invalid={targetError && target !== manual} options={[...sessions.map(session => ({ value: session.session_id, label: sessionName(session, t) })), { value: manual, label: t('webhooks.common.manualSessionId'), separatorBefore: sessions.length > 0 }]} onValueChange={value => { setTarget(value); setTargetError(false); focusManual.current = value === manual; }} onOpenChangeComplete={open => { if (!open && focusManual.current) { focusManual.current = false; manualInput.current?.focus(); } }} message={targetError && target !== manual ? t('webhooks.common.sessionUnavailable') : sessionsState === 'error' ? t('webhooks.common.sessionsLoadError') : undefined}/>
              {target === manual && <div className="access-links-manual"><Input ref={manualInput} aria-label={t('webhooks.common.sessionId')} aria-invalid={targetError || (idTouched && !uuid.test(manualId.trim())) || undefined} value={manualId} disabled={busy} onChange={e => { setManualId(e.target.value); setTargetError(false); }} onBlur={() => setIdTouched(true)}/>{targetError ? <small role="alert">{t('webhooks.common.sessionUnavailable')}</small> : idTouched && !uuid.test(manualId.trim()) && <small role="alert">{t('webhooks.common.invalidSessionId')}</small>}</div>}
            </div>
            <SettingsField label={t('webhooks.common.sender')}><Input aria-label={t('webhooks.common.sender')} maxLength={80} value={label} disabled={busy} onChange={e => setLabel(e.target.value)}/></SettingsField>
            <CatalogSelectionField className="access-links-field" label={t('webhooks.common.duration')} ariaLabel={t('webhooks.common.duration')} value={duration} selectedLabel={durations.find(item => item.value === duration)?.label} options={durations} disabled={busy} onValueChange={setDuration}/>
            <fieldset><legend className="text-sm text-muted-foreground">{t('webhooks.access.permissions')}</legend><div className="-mx-2">{permissions.map(item => <label key={item.value} className="flex items-start gap-2 rounded-floor px-2 py-1.5 text-sm hover:bg-muted/40"><Checkbox className="mt-0.5" checked={selected.includes(item.value)} disabled={busy} onCheckedChange={checked => setSelected(current => checked ? [...current, item.value] : current.filter(value => value !== item.value))}/><span className="access-links-permission">{item.label}{item.description && <small>{item.description}</small>}</span></label>)}</div>{!selected.length && <small role="alert">{t('webhooks.common.selectAtLeastOne')}</small>}</fieldset>
            {error && <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{error}</span></SettingsAlert>}
          </DialogPanel>}
        <DialogFooter>{url ? <><Button variant="outline" onClick={closeEditor}>{t('webhooks.common.close')}</Button><Button ref={copyButton} onClick={() => { void navigator.clipboard.writeText(url).then(() => { setCopied(true); setCopyError(false); }).catch(() => { setCopied(false); setCopyError(true); }); }}>{copied ? t('webhooks.common.copied') : t('webhooks.common.copy')}</Button></> : <><Button variant="outline" disabled={busy} onClick={closeEditor}>{t('webhooks.common.cancel')}</Button><Button disabled={!busy && (!target || (target === manual && !manualId.trim()) || !label.trim() || !selected.length)} className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void issue()}>{busy ? t('webhooks.common.creating') : t('webhooks.access.create')}</Button></>}</DialogFooter>
      </DialogPopup>
    </Dialog>
    <Dialog open={revoking !== null} onOpenChange={open => { if (!open && !busy) { returnRevokeFocus.current = revoking?.id ?? ''; setRevoking(null); } }} onOpenChangeComplete={open => { if (!open) (revokeButtons.current.get(returnRevokeFocus.current) ?? createButton.current)?.focus(); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={cancelRevoke} finalFocus={() => revokeButtons.current.get(returnRevokeFocus.current) ?? createButton.current}><DialogHeader><DialogTitle>{t('webhooks.access.revokeTitle')}</DialogTitle><DialogDescription className="access-links-revoke-description">{t('webhooks.access.revokeHelp', { label: revoking?.label ?? '' })}</DialogDescription></DialogHeader>
        {revokeError && <DialogPanel><SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.common.revokeError')}</span></SettingsAlert></DialogPanel>}
        <DialogFooter><Button ref={cancelRevoke} variant="outline" disabled={busy} onClick={() => { returnRevokeFocus.current = revoking?.id ?? ''; setRevoking(null); }}>{t('webhooks.common.cancel')}</Button><Button variant="destructive" className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void revoke()}>{busy ? t('webhooks.common.revoking') : t('webhooks.common.revoke')}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  </div>;
}
