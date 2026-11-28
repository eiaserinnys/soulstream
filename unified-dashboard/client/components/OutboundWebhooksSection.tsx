import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, DashboardIconCap, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Input, Switch } from '@seosoyoung/soul-ui';
import { Check, ChevronRight, Copy, RotateCw } from 'lucide-react';
import type { PersistentSession } from '../lib/persistent-sessions';
import {
  challengeReasonText,
  deliveryAttemptText,
  deliveryStateLabel,
  eventTypeLabel,
  eventTypesLabel,
  formatClock,
  lastErrorText,
  outboundDisabledDetail,
  outboundDisabledText,
  sessionName,
  sessionShortName,
  type WebhookTranslate,
  WebhooksError,
  type DeliveryState,
  type OutboundEventType,
  type OutboundSubscription,
  type OutboundWebhookCreated,
  type WebhookDelivery,
  type WebhooksApi,
} from '../lib/webhooks-api';
import { CatalogSelectionField } from './CatalogSelectionField';
import { busyButtonClassName } from './config/busy-button';
import { SettingsAlert, SettingsField } from './config/SettingsListDetail';
import './config/owned-agents.css';
import './config/access-links.css';

const manual = 'manual';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}
function validUrl(value: string) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}
function createErrorText(cause: unknown, t: WebhookTranslate) {
  const status = cause instanceof WebhooksError ? cause.status : 0;
  if (status === 401) return t('webhooks.common.relogin');
  if (status === 422) return t('webhooks.common.checkInput');
  return t('webhooks.outbound.createError');
}

export function OutboundWebhooksSection({ api, items, error, reload, names, sessions, sessionsState }: {
  api: WebhooksApi;
  items: OutboundSubscription[] | null;
  error: boolean;
  reload(): Promise<void>;
  names: Map<string, string>;
  sessions: PersistentSession[];
  sessionsState: 'loading' | 'ready' | 'error';
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const events: { value: OutboundEventType; label: string; description?: string }[] = [
    { value: 'session.reply', label: eventTypeLabel('session.reply', t) },
    { value: 'session.question', label: eventTypeLabel('session.question', t), description: t('webhooks.outbound.questionHelp') },
    { value: 'session.failed', label: eventTypeLabel('session.failed', t), description: t('webhooks.outbound.sessionFailedHelp') },
    { value: 'session.ended', label: eventTypeLabel('session.ended', t), description: t('webhooks.outbound.sessionEndedHelp') },
  ];
  const filters: { value: '' | DeliveryState; label: string }[] = [
    { value: '', label: t('webhooks.outbound.all') },
    { value: 'dead', label: t('webhooks.outbound.failed') },
    { value: 'pending', label: t('webhooks.outbound.pending') },
  ];
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState('');
  const [manualId, setManualId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<OutboundEventType[]>(['session.reply', 'session.question', 'session.failed']);
  const [targetError, setTargetError] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<OutboundWebhookCreated | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const focusManual = useRef(false);
  const secretCopy = useRef<HTMLButtonElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef('');

  const [detail, setDetail] = useState<OutboundSubscription | null>(null);
  const [filter, setFilter] = useState<'' | DeliveryState>('');
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [deliveriesError, setDeliveriesError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [redeliverBusy, setRedeliverBusy] = useState<string | null>(null);
  const [redeliverNotice, setRedeliverNotice] = useState<{ id: string; text: string } | null>(null);
  const filterButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectedFilter = useRef<HTMLButtonElement | null>(null);
  const redeliverButtons = useRef(new Map<string, HTMLButtonElement>());
  const redeliverOrder = useRef<string[]>([]);
  const pendingFocus = useRef<string | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  const detailId = detail?.id ?? '';
  const loadDeliveries = useCallback(async (id: string, state: '' | DeliveryState, keep = false) => {
    if (!keep) { setDeliveries(null); setDeliveriesError(false); }
    else setRefreshing(true);
    try {
      const next = await api.listDeliveries(id, state === '' ? undefined : state);
      if (alive.current) { setDeliveries(next); setDeliveriesError(false); }
    } catch {
      if (alive.current) setDeliveriesError(true);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, [api]);

  useEffect(() => { if (detailId) void loadDeliveries(detailId, filter); }, [detailId, filter, loadDeliveries]);
  useEffect(() => { if (created) secretCopy.current?.focus(); }, [created]);
  useEffect(() => { if (confirming) cancelButton.current?.focus(); }, [confirming]);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || deliveries === null) return;
    pendingFocus.current = null;
    const buttons = redeliverButtons.current;
    const order = redeliverOrder.current;
    const after = [...buttons.keys()].find(id => order.indexOf(id) > order.indexOf(pending));
    (buttons.get(pending) ?? (after !== undefined ? buttons.get(after) : undefined) ?? selectedFilter.current)?.focus();
  }, [deliveries, filter]);

  function openCreate() {
    setTarget(''); setManualId(''); setIdTouched(false); setName(''); setUrl(''); setUrlTouched(false);
    setSelectedEvents(['session.reply', 'session.question', 'session.failed']);
    setTargetError(false); setChallengeError(null); setFormError(null); setCreated(null); setCopied(null); setCopyError(false);
    setCreating(true);
  }
  function closeCreate() { setCreating(false); }
  function openDetail(item: OutboundSubscription) {
    returnFocus.current = item.id; setConfirming(false); setDeleteError(false); setSwitchError(false);
    setRedeliverNotice(null); setCopied(null); setCopyError(false); setFilter(''); setDeliveries(null); setDeliveriesError(false);
    setDetail(item);
  }
  function closeDetail() { setDetail(null); setConfirming(false); }

  const hasTarget = target !== '' && (target !== manual || uuid.test(manualId.trim()));
  const canCreate = hasTarget && name.trim().length > 0 && validUrl(url.trim()) && selectedEvents.length > 0;

  async function create() {
    if (inFlight.current || !canCreate) return;
    const id = target === manual ? manualId.trim() : target;
    inFlight.current = true; setBusy(true); setFormError(null); setTargetError(false); setChallengeError(null);
    try {
      const result = await api.createOutbound({ target_session_id: id, label: name.trim(), url: url.trim(), event_types: selectedEvents });
      if (alive.current) { setCreated(result); void reload(); }
    } catch (cause) {
      if (alive.current) {
        const status = cause instanceof WebhooksError ? cause.status : 0;
        const code = cause instanceof WebhooksError ? cause.code : undefined;
        if (status === 404 || status === 403) setTargetError(true);
        else if (status === 422 && code === 'challenge_failed') setChallengeError(challengeReasonText(cause instanceof WebhooksError ? cause.reason : undefined, t));
        else setFormError(createErrorText(cause, t));
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      if (alive.current) { setCopied(key); setCopyError(false); }
    }).catch(() => {
      if (alive.current) { setCopied(null); setCopyError(true); }
    });
  }

  async function toggle(next: boolean) {
    if (!detail || switchBusy || inFlight.current) return;
    const id = detail.id;
    inFlight.current = true; setSwitchBusy(true); setSwitchError(false);
    try {
      const updated = await api.setOutboundActive(id, next);
      if (alive.current) { setDetail(updated); await reload(); await loadDeliveries(id, filter); }
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof WebhooksError && cause.status === 404) { await reload(); if (alive.current) { returnFocus.current = id; setDetail(null); } }
      else setSwitchError(true);
    } finally { inFlight.current = false; if (alive.current) setSwitchBusy(false); }
  }

  async function redeliver(item: WebhookDelivery) {
    if (!detail || redeliverBusy !== null || inFlight.current) return;
    inFlight.current = true;
    redeliverOrder.current = (deliveries ?? []).filter(entry => entry.state === 'dead').map(entry => entry.id);
    pendingFocus.current = item.id;
    setRedeliverBusy(item.id); setRedeliverNotice(null);
    try {
      const outcome = await api.redeliver(detail.id, item.id);
      if (!alive.current) { pendingFocus.current = null; return; }
      if (outcome === 'dead') setRedeliverNotice({ id: item.id, text: t('webhooks.outbound.redeliveryFailed') });
      else if (outcome === 'skipped') setRedeliverNotice({ id: item.id, text: t('webhooks.outbound.redeliveryError') });
      await loadDeliveries(detail.id, filter, true);
      if (outcome === 'delivered') void reload();
    } catch (cause) {
      if (!alive.current) { pendingFocus.current = null; return; }
      const status = cause instanceof WebhooksError ? cause.status : 0;
      if (status === 409) {
        setDetail(current => current === null ? current : { ...current, active: false });
        setRedeliverNotice({ id: item.id, text: t('webhooks.outbound.redeliveryDisabled') });
        await loadDeliveries(detail.id, filter, true); void reload();
      } else { pendingFocus.current = null; setRedeliverNotice({ id: item.id, text: t('webhooks.outbound.redeliveryError') }); }
    } finally { inFlight.current = false; if (alive.current) setRedeliverBusy(null); }
  }

  async function remove() {
    if (!detail || inFlight.current) return;
    const list = items ?? [];
    const index = list.findIndex(item => item.id === detail.id);
    const next = list[index + 1]?.id ?? list[index - 1]?.id ?? '';
    inFlight.current = true; setBusy(true); setDeleteError(false);
    let done = false;
    try {
      try { await api.deleteOutbound(detail.id); } catch (cause) { if (!(cause instanceof WebhooksError && cause.status === 404)) throw cause; }
      await reload();
      done = true;
    } catch {
      if (alive.current) setDeleteError(true);
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
    if (done && alive.current) { returnFocus.current = next; setConfirming(false); setDetail(null); }
  }

  const row = (item: OutboundSubscription) => {
    const disabled = outboundDisabledText(item, t);
    return <div className={`owned-agents-block access-links-row${item.active ? '' : ' is-past'}`} key={item.id}>
      <button
        type="button"
        className="webhooks-row"
        ref={element => { if (element) rowButtons.current.set(item.id, element); else rowButtons.current.delete(item.id); }}
        onClick={() => openDetail(item)}
      >
        <span className="access-links-copy webhooks-row-copy">
          <span className="access-links-label" title={item.label} data-v3-selectable-content="true">{item.label}</span>
          <span className="owned-agents-meta access-links-meta" data-v3-selectable-content="true">
            {disabled && <span className={disabled.danger ? 'webhooks-danger' : undefined}>{disabled.text}</span>}
            <span>{names.get(item.target_session_id) ?? sessionShortName(item.target_session_id, t)}</span>
            <span>{eventTypesLabel(item.event_types, t)}</span>
            <span>{hostOf(item.url)}</span>
            {item.active && (item.recent_failures ?? 0) > 0 && <span className="webhooks-danger">{t('webhooks.outbound.failures24h', { count: item.recent_failures })}</span>}
          </span>
        </span>
        <ChevronRight className="size-4 webhooks-chevron" aria-hidden="true"/>
      </button>
    </div>;
  };

  const deliveryList = () => deliveriesError ? <div className="space-y-2">
    <SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.outbound.deliveriesError')}</span></SettingsAlert>
    {detail && <Button variant="outline" onClick={() => void loadDeliveries(detail.id, filter)}>{t('webhooks.common.retry')}</Button>}
  </div> : deliveries === null
    ? <div role="status" aria-label={t('webhooks.common.loading')}>{[0, 1].map(index => <div className="owned-agents-block" key={index}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
    : deliveries.length === 0
      ? <p className="access-links-empty">{filter === 'dead' ? t('webhooks.outbound.noFailed') : filter === 'pending' ? t('webhooks.outbound.noPending') : t('webhooks.outbound.noDeliveries')}</p>
      : <>{deliveries.map(item => {
        const attempt = deliveryAttemptText(item.attempt_count, t);
        return <div className="owned-agents-block" key={item.id}>
          <div className="owned-agents-key-row">
            <div className="access-links-copy">
              <p className="webhooks-record-title">{eventTypeLabel(item.event_type, t)}<span className={item.state === 'dead' ? 'webhooks-danger' : undefined}>{deliveryStateLabel(item.state, t)}</span></p>
              <p className="owned-agents-meta access-links-meta" data-v3-selectable-content="true">
                <span>{formatClock(item.created_at, locale)}</span>
                {attempt !== null && <span>{attempt}</span>}
                {item.last_status !== null ? <span>{t('webhooks.outbound.response', { status: item.last_status })}</span> : item.last_error !== null ? <span>{lastErrorText(item.last_error, t)}</span> : null}
                {item.state === 'pending' && <span>{t('webhooks.outbound.nextAttempt', { time: formatClock(item.next_attempt_at, locale) })}</span>}
              </p>
              {redeliverNotice?.id === item.id && <p className="webhooks-danger">{redeliverNotice.text}</p>}
            </div>
            {item.state === 'dead' && detail?.active === true && <Button
              ref={element => { if (element) redeliverButtons.current.set(item.id, element); else redeliverButtons.current.delete(item.id); }}
              variant="outline"
              className={redeliverBusy === item.id ? busyButtonClassName : undefined}
              aria-disabled={redeliverBusy !== null || undefined}
              onClick={() => void redeliver(item)}
            >{redeliverBusy === item.id ? t('webhooks.outbound.sending') : t('webhooks.outbound.resend')}</Button>}
          </div>
        </div>;
      })}</>;

  const disabledDetail = detail && !detail.active ? outboundDisabledDetail(detail.disabled_reason, t) : null;
  return <section className="webhooks-section" aria-label={t('webhooks.outbound.title')}>
    <div className="owned-agents-row"><h3>{t('webhooks.outbound.title')}</h3><Button ref={createButton} variant="outline" onClick={openCreate}>{t('webhooks.outbound.create')}</Button></div>
    {error ? <div className="space-y-2">
      <SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.outbound.loadError')}</span></SettingsAlert>
      <Button variant="outline" onClick={() => void reload()}>{t('webhooks.common.retry')}</Button>
    </div> : items === null
      ? <div role="status" aria-label={t('webhooks.common.loading')}>{[0, 1].map(index => <div className="owned-agents-block" key={index}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
      : items.length === 0
        ? <p className="access-links-empty">{t('webhooks.outbound.empty')}</p>
        : <>{items.map(row)}</>}

    <Dialog open={creating} onOpenChange={open => { if (!open && !busy) closeCreate(); }} onOpenChangeComplete={open => { if (!open) { setCreated(null); setCopied(null); setCopyError(false); createButton.current?.focus(); } }}>
      <DialogPopup className="approved-dialog webhooks-dialog" closeProps={{ disabled: busy }} initialFocus={targetButton}>
        <DialogHeader>
          <DialogTitle>{created ? t('webhooks.outbound.created') : t('webhooks.outbound.createTitle')}</DialogTitle>
          <DialogDescription>{created ? t('webhooks.common.signingSecretOnce') : t('webhooks.outbound.createHelp')}</DialogDescription>
        </DialogHeader>
        {created ? <DialogPanel>
          <div className="webhooks-values">
            <div className="webhooks-value">
              <p className="owned-agents-meta">{t('webhooks.common.signingSecret')}</p>
              <div className="owned-agents-key-row">
                <div><p className="owned-agents-token" data-v3-selectable-content="true">{created.signing_secret}</p></div>
                <DashboardIconCap ref={secretCopy} size="small" label={copied === 'secret' ? t('webhooks.common.copied') : t('webhooks.common.copySigningSecret')} onClick={() => copy('secret', created.signing_secret)}>
                  {copied === 'secret' ? <Check className="size-4"/> : <Copy className="size-4"/>}
                </DashboardIconCap>
              </div>
            </div>
          </div>
          {copyError && <SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.common.copyValueError')}</span></SettingsAlert>}
        </DialogPanel> : <DialogPanel className="access-links-form">
          <div>
            <CatalogSelectionField className="access-links-field" label={t('webhooks.common.targetSession')} ariaLabel={t('webhooks.common.targetSession')} triggerRef={targetButton} triggerClassName={!target ? 'text-muted-foreground' : undefined} value={target} selectedLabel={sessionsState === 'loading' ? t('webhooks.common.loadingProgress') : target === manual ? t('webhooks.common.manualSessionId') : names.get(target) ?? t('webhooks.common.selectSession')} disabled={busy || sessionsState === 'loading'} invalid={targetError} options={[...sessions.map(session => ({ value: session.session_id, label: sessionName(session, t) })), { value: manual, label: t('webhooks.common.manualSessionId'), separatorBefore: sessions.length > 0 }]} onValueChange={value => { setTarget(value); setTargetError(false); focusManual.current = value === manual; }} onOpenChangeComplete={open => { if (!open && focusManual.current) { focusManual.current = false; manualInput.current?.focus(); } }} message={targetError ? t('webhooks.common.sessionUnavailable') : sessionsState === 'error' ? t('webhooks.common.sessionsLoadError') : undefined}/>
            {target === manual && <div className="access-links-manual"><Input ref={manualInput} aria-label={t('webhooks.common.sessionId')} aria-invalid={targetError || (idTouched && !uuid.test(manualId.trim())) || undefined} value={manualId} disabled={busy} onChange={event => { setManualId(event.target.value); setTargetError(false); }} onBlur={() => setIdTouched(true)}/>{targetError ? <small role="alert">{t('webhooks.common.sessionUnavailable')}</small> : idTouched && !uuid.test(manualId.trim()) && <small role="alert">{t('webhooks.common.invalidSessionId')}</small>}</div>}
          </div>
          <SettingsField label={t('webhooks.outbound.name')}><Input aria-label={t('webhooks.outbound.name')} maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></SettingsField>
          <div className="access-links-field">
            <SettingsField label={t('webhooks.outbound.callback')}><Input aria-label={t('webhooks.outbound.callback')} type="url" inputMode="url" spellCheck={false} maxLength={2048} value={url} disabled={busy} aria-invalid={challengeError !== null || (urlTouched && !validUrl(url.trim())) || undefined} onChange={event => { setUrl(event.target.value); setChallengeError(null); }} onBlur={() => setUrlTouched(true)}/></SettingsField>
            {challengeError !== null ? <small role="alert">{challengeError}</small> : urlTouched && !validUrl(url.trim()) && <small role="alert">{t('webhooks.outbound.httpsRequired')}</small>}
            <p className="access-links-hint">{t('webhooks.outbound.challengeHelp')}</p>
          </div>
          <fieldset><legend className="text-sm text-muted-foreground">{t('webhooks.outbound.events')}</legend><div className="-mx-2">{events.map(item => <label key={item.value} className="flex items-start gap-2 rounded-floor px-2 py-1.5 text-sm hover:bg-muted/40"><Checkbox className="mt-0.5" checked={selectedEvents.includes(item.value)} disabled={busy} onCheckedChange={checked => setSelectedEvents(current => checked ? [...current, item.value] : current.filter(value => value !== item.value))}/><span className="access-links-permission">{item.label}{item.description && <small>{item.description}</small>}</span></label>)}</div>{!selectedEvents.length && <small role="alert">{t('webhooks.common.selectAtLeastOne')}</small>}</fieldset>
          {formError && <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{formError}</span></SettingsAlert>}
        </DialogPanel>}
        <DialogFooter>{created
          ? <Button variant="outline" onClick={closeCreate}>{t('webhooks.common.close')}</Button>
          : <><Button variant="outline" disabled={busy} onClick={closeCreate}>{t('webhooks.common.cancel')}</Button><Button disabled={!busy && !canCreate} className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void create()}>{busy ? t('webhooks.outbound.verifying') : t('webhooks.outbound.submit')}</Button></>}</DialogFooter>
      </DialogPopup>
    </Dialog>

    <Dialog open={detail !== null} onOpenChange={open => { if (!open && !busy) closeDetail(); }} onOpenChangeComplete={open => { if (!open) (rowButtons.current.get(returnFocus.current) ?? createButton.current)?.focus(); }}>
      <DialogPopup className="approved-dialog webhooks-dialog" closeProps={{ disabled: busy }} initialFocus={selectedFilter}>
        {confirming ? <>
          <DialogHeader><DialogTitle>{t('webhooks.outbound.deleteTitle')}</DialogTitle><DialogDescription className="access-links-revoke-description">{t('webhooks.outbound.deleteHelp', { label: detail?.label ?? '' })}</DialogDescription></DialogHeader>
          {deleteError && <DialogPanel><SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.outbound.deleteError')}</span></SettingsAlert></DialogPanel>}
          <DialogFooter><Button ref={cancelButton} variant="outline" disabled={busy} onClick={() => { setDeleteError(false); setConfirming(false); requestAnimationFrame(() => deleteButton.current?.focus()); }}>{t('webhooks.common.cancel')}</Button><Button variant="destructive" className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void remove()}>{busy ? t('webhooks.outbound.deleting') : t('webhooks.outbound.delete')}</Button></DialogFooter>
        </> : detail !== null ? <>
          <DialogHeader><DialogTitle className="access-links-revoke-description">{detail.label}</DialogTitle><DialogDescription className="access-links-revoke-description" data-v3-selectable-content="true">{detail.url}</DialogDescription></DialogHeader>
          <DialogPanel>
            <div className="webhooks-switch">
              <div className="owned-agents-row">
                <p className="webhooks-switch-name">{t('webhooks.outbound.sendEvents')}</p>
                <Switch aria-label={t('webhooks.outbound.sendEvents')} checked={detail.active} aria-disabled={switchBusy || busy || undefined} onCheckedChange={next => void toggle(next)}/>
              </div>
              {disabledDetail !== null && <p className="webhooks-danger">{disabledDetail}</p>}
              {!detail.active && <p className="access-links-hint">{t('webhooks.outbound.reenableHelp')}</p>}
              {switchError && <SettingsAlert><span data-v3-selectable-content="true">{t('webhooks.outbound.toggleError')}</span></SettingsAlert>}
            </div>
            <div className="webhooks-records">
              <div className="webhooks-filter-row">
                <div className="v3-completed-periods" role="group" aria-label={t('webhooks.outbound.filterDeliveries')}>
                  {filters.map(option => <Button
                    key={option.value || 'all'}
                    ref={element => { if (element) { filterButtons.current.set(option.value, element); if (filter === option.value) selectedFilter.current = element; } }}
                    size="sm"
                    variant="ghost"
                    aria-pressed={filter === option.value}
                    onClick={() => setFilter(option.value)}
                  >{option.label}</Button>)}
                </div>
                <DashboardIconCap ref={refreshButton} size="small" label={t('webhooks.common.refresh')} disabled={refreshing} onClick={() => void loadDeliveries(detail.id, filter, true)}><RotateCw className="size-4"/></DashboardIconCap>
              </div>
              {deliveryList()}
            </div>
          </DialogPanel>
          <DialogFooter><Button ref={deleteButton} variant="destructive-outline" className="sm:mr-auto" disabled={busy} onClick={() => { setDeleteError(false); setConfirming(true); }}>{t('webhooks.outbound.delete')}</Button><Button variant="outline" onClick={closeDetail}>{t('webhooks.common.close')}</Button></DialogFooter>
        </> : null}
      </DialogPopup>
    </Dialog>
  </section>;
}
