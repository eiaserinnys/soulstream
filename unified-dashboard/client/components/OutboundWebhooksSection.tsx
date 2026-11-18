import { useCallback, useEffect, useRef, useState } from 'react';
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
const events: { value: OutboundEventType; label: string; description?: string }[] = [
  { value: 'session.reply', label: '답변' },
  { value: 'session.question', label: '질문', description: '선택지로 묻는 질문' },
  { value: 'session.failed', label: '세션 실패', description: '오류나 한도로 끝남' },
  { value: 'session.ended', label: '세션 끝남', description: '정상으로 끝나거나 사람이 멈춤' },
];
const filters: { value: '' | DeliveryState; label: string }[] = [
  { value: '', label: '전체' },
  { value: 'dead', label: '실패' },
  { value: 'pending', label: '대기' },
];
const sessionName = (session: PersistentSession) => session.display_name || `${session.agent_name || '에이전트'} 세션`;
const targetName = (names: Map<string, string>, id: string) => names.get(id) ?? `세션 ${id.slice(0, 8)}`;
function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}
function validUrl(value: string) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}
function createErrorText(cause: unknown) {
  const status = cause instanceof WebhooksError ? cause.status : 0;
  if (status === 401) return '로그인이 끝났습니다. 다시 로그인하세요.';
  if (status === 422) return '입력을 다시 확인하세요.';
  return '지금은 등록할 수 없습니다. 잠시 뒤 다시 시도하세요.';
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
        else if (status === 422 && code === 'challenge_failed') setChallengeError(challengeReasonText(cause instanceof WebhooksError ? cause.reason : undefined));
        else setFormError(createErrorText(cause));
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
      if (outcome === 'dead') setRedeliverNotice({ id: item.id, text: '다시 보냈지만 실패했습니다.' });
      else if (outcome === 'skipped') setRedeliverNotice({ id: item.id, text: '지금은 다시 보내지 못했습니다. 다시 시도하세요.' });
      await loadDeliveries(detail.id, filter, true);
      if (outcome === 'delivered') void reload();
    } catch (cause) {
      if (!alive.current) { pendingFocus.current = null; return; }
      const status = cause instanceof WebhooksError ? cause.status : 0;
      if (status === 409) {
        setDetail(current => current === null ? current : { ...current, active: false });
        setRedeliverNotice({ id: item.id, text: '꺼진 상태에서는 다시 보낼 수 없습니다.' });
        await loadDeliveries(detail.id, filter, true); void reload();
      } else { pendingFocus.current = null; setRedeliverNotice({ id: item.id, text: '지금은 다시 보내지 못했습니다. 다시 시도하세요.' }); }
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
    const disabled = outboundDisabledText(item);
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
            <span>{targetName(names, item.target_session_id)}</span>
            <span>{eventTypesLabel(item.event_types)}</span>
            <span>{hostOf(item.url)}</span>
            {item.active && (item.recent_failures ?? 0) > 0 && <span className="webhooks-danger">24시간 실패 {item.recent_failures}건</span>}
          </span>
        </span>
        <ChevronRight className="size-4 webhooks-chevron" aria-hidden="true"/>
      </button>
    </div>;
  };

  const deliveryList = () => deliveriesError ? <div className="space-y-2">
    <SettingsAlert><span data-v3-selectable-content="true">전달 기록을 불러오지 못했습니다.</span></SettingsAlert>
    {detail && <Button variant="outline" onClick={() => void loadDeliveries(detail.id, filter)}>다시 시도</Button>}
  </div> : deliveries === null
    ? <div role="status" aria-label="불러오는 중">{[0, 1].map(index => <div className="owned-agents-block" key={index}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
    : deliveries.length === 0
      ? <p className="access-links-empty">{filter === 'dead' ? '실패한 전달이 없습니다.' : filter === 'pending' ? '기다리는 전달이 없습니다.' : '아직 보낸 소식이 없습니다.'}</p>
      : <>{deliveries.map(item => {
        const attempt = deliveryAttemptText(item.attempt_count);
        return <div className="owned-agents-block" key={item.id}>
          <div className="owned-agents-key-row">
            <div className="access-links-copy">
              <p className="webhooks-record-title">{eventTypeLabel(item.event_type)}<span className={item.state === 'dead' ? 'webhooks-danger' : undefined}>{deliveryStateLabel(item.state)}</span></p>
              <p className="owned-agents-meta access-links-meta" data-v3-selectable-content="true">
                <span>{formatClock(item.created_at)}</span>
                {attempt !== null && <span>{attempt}</span>}
                {item.last_status !== null ? <span>응답 {item.last_status}</span> : item.last_error !== null ? <span>{lastErrorText(item.last_error)}</span> : null}
                {item.state === 'pending' && <span>다음 시도 {formatClock(item.next_attempt_at)}</span>}
              </p>
            </div>
            {item.state === 'dead' && detail?.active === true && <Button
              ref={element => { if (element) redeliverButtons.current.set(item.id, element); else redeliverButtons.current.delete(item.id); }}
              variant="outline"
              className={redeliverBusy === item.id ? busyButtonClassName : undefined}
              aria-disabled={redeliverBusy !== null || undefined}
              onClick={() => void redeliver(item)}
            >{redeliverBusy === item.id ? '보내는 중…' : '다시 보내기'}</Button>}
          </div>
          {redeliverNotice?.id === item.id && <p className="webhooks-danger">{redeliverNotice.text}</p>}
        </div>;
      })}</>;

  return <section className="webhooks-section" aria-label="나가는 웹훅">
    <div className="owned-agents-row"><h3>나가는 웹훅</h3><Button ref={createButton} variant="outline" onClick={openCreate}>주소 등록</Button></div>
    {error ? <div className="space-y-2">
      <SettingsAlert><span data-v3-selectable-content="true">등록한 주소를 불러오지 못했습니다.</span></SettingsAlert>
      <Button variant="outline" onClick={() => void reload()}>다시 시도</Button>
    </div> : items === null
      ? <div role="status" aria-label="불러오는 중">{[0, 1].map(index => <div className="owned-agents-block" key={index}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
      : items.length === 0
        ? <p className="access-links-empty">아직 등록한 주소가 없습니다.</p>
        : <>{items.map(row)}</>}

    <Dialog open={creating} onOpenChange={open => { if (!open && !busy) closeCreate(); }} onOpenChangeComplete={open => { if (!open) { setCreated(null); setCopied(null); setCopyError(false); createButton.current?.focus(); } }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={targetButton}>
        <DialogHeader>
          <DialogTitle>{created ? '주소를 등록했습니다' : '나가는 웹훅 등록'}</DialogTitle>
          <DialogDescription>{created ? '서명 비밀은 지금 한 번만 보입니다. 닫기 전에 복사하세요.' : '등록한 주소는 대상 세션의 답변 전체를 받습니다.'}</DialogDescription>
        </DialogHeader>
        {created ? <DialogPanel>
          <div className="webhooks-values">
            <div className="webhooks-value">
              <p className="owned-agents-meta">서명 비밀 (Standard Webhooks)</p>
              <div className="owned-agents-key-row">
                <div><p className="owned-agents-token" data-v3-selectable-content="true">{created.signing_secret}</p></div>
                <DashboardIconCap ref={secretCopy} size="small" label={copied === 'secret' ? '복사됨' : '서명 비밀 복사'} onClick={() => copy('secret', created.signing_secret)}>
                  {copied === 'secret' ? <Check className="size-4"/> : <Copy className="size-4"/>}
                </DashboardIconCap>
              </div>
            </div>
          </div>
          {copyError && <SettingsAlert><span data-v3-selectable-content="true">복사하지 못했습니다. 값을 직접 골라 복사하세요.</span></SettingsAlert>}
        </DialogPanel> : <DialogPanel className="access-links-form">
          <div>
            <CatalogSelectionField className="access-links-field" label="대상 세션" ariaLabel="대상 세션" triggerRef={targetButton} triggerClassName={!target ? 'text-muted-foreground' : undefined} value={target} selectedLabel={sessionsState === 'loading' ? '불러오는 중…' : target === manual ? '세션 ID 직접 입력' : names.get(target) ?? '세션을 고르세요'} disabled={busy || sessionsState === 'loading'} invalid={targetError} options={[...sessions.map(session => ({ value: session.session_id, label: sessionName(session) })), { value: manual, label: '세션 ID 직접 입력', separatorBefore: sessions.length > 0 }]} onValueChange={value => { setTarget(value); setTargetError(false); focusManual.current = value === manual; }} onOpenChangeComplete={open => { if (!open && focusManual.current) { focusManual.current = false; manualInput.current?.focus(); } }} message={targetError ? '이 세션을 찾지 못했거나 열 수 없습니다.' : sessionsState === 'error' ? '영구 세션 목록을 불러오지 못했습니다.' : undefined}/>
            {target === manual && <div className="access-links-manual"><Input ref={manualInput} aria-label="세션 ID" aria-invalid={targetError || (idTouched && !uuid.test(manualId.trim())) || undefined} value={manualId} disabled={busy} onChange={event => { setManualId(event.target.value); setTargetError(false); }} onBlur={() => setIdTouched(true)}/>{targetError ? <small role="alert">이 세션을 찾지 못했거나 열 수 없습니다.</small> : idTouched && !uuid.test(manualId.trim()) && <small role="alert">세션 ID 형식이 아닙니다.</small>}</div>}
          </div>
          <SettingsField label="이름"><Input aria-label="이름" maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></SettingsField>
          <div className="access-links-field">
            <SettingsField label="받을 주소"><Input aria-label="받을 주소" type="url" inputMode="url" spellCheck={false} maxLength={2048} value={url} disabled={busy} aria-invalid={challengeError !== null || (urlTouched && !validUrl(url.trim())) || undefined} onChange={event => { setUrl(event.target.value); setChallengeError(null); }} onBlur={() => setUrlTouched(true)}/></SettingsField>
            {challengeError !== null ? <small role="alert">{challengeError}</small> : urlTouched && !validUrl(url.trim()) && <small role="alert">https 주소를 넣으세요.</small>}
            <p className="access-links-hint">등록할 때 확인 요청을 보냅니다. 본문의 challenge를 JSON으로 그대로 돌려줘야 합니다.</p>
          </div>
          <fieldset><legend className="text-sm text-muted-foreground">보낼 소식</legend><div className="-mx-2">{events.map(item => <label key={item.value} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40"><Checkbox className="mt-0.5" checked={selectedEvents.includes(item.value)} disabled={busy} onCheckedChange={checked => setSelectedEvents(current => checked ? [...current, item.value] : current.filter(value => value !== item.value))}/><span className="access-links-permission">{item.label}{item.description && <small>{item.description}</small>}</span></label>)}</div>{!selectedEvents.length && <small role="alert">하나 이상 고르세요.</small>}</fieldset>
          {formError && <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{formError}</span></SettingsAlert>}
        </DialogPanel>}
        <DialogFooter>{created
          ? <Button variant="outline" onClick={closeCreate}>닫기</Button>
          : <><Button variant="outline" disabled={busy} onClick={closeCreate}>취소</Button><Button disabled={!busy && !canCreate} className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void create()}>{busy ? '확인하는 중…' : '등록'}</Button></>}</DialogFooter>
      </DialogPopup>
    </Dialog>

    <Dialog open={detail !== null} onOpenChange={open => { if (!open && !busy) closeDetail(); }} onOpenChangeComplete={open => { if (!open) (rowButtons.current.get(returnFocus.current) ?? createButton.current)?.focus(); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={selectedFilter}>
        {confirming ? <>
          <DialogHeader><DialogTitle>나가는 웹훅 삭제</DialogTitle><DialogDescription className="access-links-revoke-description">“{detail?.label}”로 더는 보내지 않고 전달 기록도 지웁니다.</DialogDescription></DialogHeader>
          {deleteError && <DialogPanel><SettingsAlert><span data-v3-selectable-content="true">지금은 삭제하지 못했습니다. 다시 시도하세요.</span></SettingsAlert></DialogPanel>}
          <DialogFooter><Button ref={cancelButton} variant="outline" disabled={busy} onClick={() => { setDeleteError(false); setConfirming(false); requestAnimationFrame(() => deleteButton.current?.focus()); }}>취소</Button><Button variant="destructive" className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void remove()}>{busy ? '삭제 중…' : '삭제'}</Button></DialogFooter>
        </> : detail !== null ? <>
          <DialogHeader><DialogTitle className="access-links-revoke-description">{detail.label}</DialogTitle><DialogDescription className="access-links-revoke-description" data-v3-selectable-content="true">{detail.url}</DialogDescription></DialogHeader>
          <DialogPanel>
            <div className="webhooks-switch">
              <div className="owned-agents-row">
                <p className="webhooks-switch-name">소식 보내기</p>
                <Switch aria-label="소식 보내기" checked={detail.active} aria-disabled={switchBusy || busy || undefined} onCheckedChange={next => void toggle(next)}/>
              </div>
              {!detail.active && outboundDisabledDetail(detail.disabled_reason) !== null && <p className="webhooks-danger">{outboundDisabledDetail(detail.disabled_reason)}</p>}
              {!detail.active && <p className="access-links-hint">다시 켜면 꺼져 있던 동안의 소식은 보내지 않습니다. 남아 있던 대기 건은 실패로 닫힙니다.</p>}
              {switchError && <SettingsAlert><span data-v3-selectable-content="true">지금은 바꾸지 못했습니다. 다시 시도하세요.</span></SettingsAlert>}
            </div>
            <div className="webhooks-records">
              <div className="webhooks-filter-row">
                <div className="v3-completed-periods" role="group" aria-label="전달 기록 거르기">
                  {filters.map(option => <Button
                    key={option.value || 'all'}
                    ref={element => { if (element) { filterButtons.current.set(option.value, element); if (filter === option.value) selectedFilter.current = element; } }}
                    size="sm"
                    variant="ghost"
                    aria-pressed={filter === option.value}
                    onClick={() => setFilter(option.value)}
                  >{option.label}</Button>)}
                </div>
                <DashboardIconCap ref={refreshButton} size="small" label="새로 고침" disabled={refreshing} onClick={() => void loadDeliveries(detail.id, filter, true)}><RotateCw className="size-4"/></DashboardIconCap>
              </div>
              {deliveryList()}
            </div>
          </DialogPanel>
          <DialogFooter><Button ref={deleteButton} variant="destructive-outline" className="sm:mr-auto" disabled={busy} onClick={() => { setDeleteError(false); setConfirming(true); }}>삭제</Button><Button variant="outline" onClick={closeDetail}>닫기</Button></DialogFooter>
        </> : null}
      </DialogPopup>
    </Dialog>
  </section>;
}
