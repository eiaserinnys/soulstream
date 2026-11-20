import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Input } from '@seosoyoung/soul-ui';
import { accessLinkStatus, AccessLinksError, createAccessLinksApi, type AccessLink, type AccessLinkPermission } from '../lib/access-links-api';
import { createPersistentSessionsApi, type PersistentSession } from '../lib/persistent-sessions';
import { CatalogSelectionField } from './CatalogSelectionField';
import { busyButtonClassName } from './config/busy-button';
import { SettingsAlert, SettingsField } from './config/SettingsListDetail';
import './config/owned-agents.css';
import './config/access-links.css';

const permissions: { value: AccessLinkPermission; label: string; description?: string }[] = [
  { value: 'send', label: '메시지 보내기' },
  { value: 'read_own', label: '답 읽기', description: '자기가 보낸 요청의 답만 봅니다' },
  { value: 'read_history', label: '대화 전체 읽기', description: '세션 대화 전체를 외부에 보여 줍니다' },
  { value: 'control', label: '세션 멈추기' },
];
const durations = [{ value: '3600', label: '1시간' }, { value: '86400', label: '하루' }, { value: '604800', label: '7일' }, { value: '2592000', label: '30일' }];
const manual = 'manual';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionName = (session: PersistentSession) => session.display_name || `${session.agent_name || '에이전트'} 세션`;
function shortDate(value: string, withTime = false) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('ko-KR', { ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }), month: 'long', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(date);
}
function lastUsed(value: string | null) {
  if (!value) return '아직 쓰지 않음';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 60) return `마지막 사용 ${minutes}분 전`;
  if (minutes < 1440) return `마지막 사용 ${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 2880) return '마지막 사용 어제';
  if (minutes < 10080) return `마지막 사용 ${Math.floor(minutes / 1440)}일 전`;
  return `마지막 사용 ${shortDate(value)}`;
}
function issueError(cause: unknown) {
  const status = cause instanceof AccessLinksError ? cause.status : 0;
  if (status === 401) return '로그인이 끝났습니다. 다시 로그인하세요.';
  if (status === 422) return '입력을 다시 확인하세요.';
  return '지금은 링크를 만들 수 없습니다. 잠시 뒤 다시 시도하세요.';
}

export function AccessLinksTab({ request = fetch }: { request?: typeof fetch }) {
  const api = useMemo(() => createAccessLinksApi(request), [request]);
  const sessionsApi = useMemo(() => createPersistentSessionsApi(request), [request]);
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
  const names = new Map(sessions.map(session => [session.session_id, sessionName(session)]));
  async function issue() {
    const id = target === manual ? manualId.trim() : target;
    if (inFlight.current || !id || !label.trim() || !selected.length) return;
    if (target === manual && !uuid.test(id)) { setIdTouched(true); return; }
    inFlight.current = true; setBusy(true); setError(null); setTargetError(false);
    try {
      const result = await api.issue({ target_session_id: id, label: label.trim(), permissions: selected, expires_in_seconds: Number(duration) });
      if (alive.current) { setUrl(result.url); void load(); }
    } catch (cause) {
      if (alive.current) { if (cause instanceof AccessLinksError && cause.status === 404) setTargetError(true); else setError(issueError(cause)); }
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
          {isPast && <span>{shortDate(status === 'revoked' ? link.revoked_at! : link.expires_at)} {status === 'revoked' ? '폐기' : '만료'}</span>}
          <span>{names.get(link.target_session_id) ?? `세션 ${link.target_session_id.slice(0, 8)}`}</span>
          <span>{link.permissions.map(p => permissions.find(item => item.value === p)?.label ?? p).join(', ')}</span>
          {!isPast && <span>{shortDate(link.expires_at, true)}까지</span>}
          <span>{lastUsed(link.last_used_at)}</span>
        </div>
      </div>{!isPast && <Button ref={el => { if (el) revokeButtons.current.set(link.id, el); else revokeButtons.current.delete(link.id); }} variant="outline" disabled={busy} onClick={() => { setRevokeError(false); setRevoking(link); requestAnimationFrame(() => cancelRevoke.current?.focus()); }}>폐기</Button>}</div>
    </div>;
  };
  return <div className="owned-agents access-links">
    <div className="owned-agents-actions"><Button ref={createButton} onClick={openEditor}>링크 만들기</Button></div>
    {listError ? <div className="space-y-2"><SettingsAlert><span data-v3-selectable-content="true">링크 목록을 불러오지 못했습니다.</span></SettingsAlert><Button variant="outline" onClick={() => { setLinks(null); void load(); }}>다시 시도</Button></div>
      : links === null ? <div role="status" aria-label="불러오는 중">{[0, 1].map(i => <div className="owned-agents-block" key={i}><div className="v3-run-skeleton v3-run-skeleton--title"/><div className="v3-run-skeleton v3-run-skeleton--preview"/></div>)}</div>
      : <>{links.length === 0 ? <p className="access-links-empty">아직 만든 링크가 없습니다.</p> : <>{active.length ? active.map(link => row(link, false)) : <p className="access-links-empty">쓸 수 있는 링크가 없습니다.</p>}{past.length > 0 && <details className="config-advanced"><summary>지난 링크 <span>{past.length}</span></summary>{past.map(link => row(link, true))}</details>}</>}</>}
    <Dialog open={editor} onOpenChange={open => { if (!open && !busy) closeEditor(); }} onOpenChangeComplete={open => { if (!open && !editor) { setUrl(null); createButton.current?.focus(); } }}>
        <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={targetButton} finalFocus={createButton}>
        <DialogHeader><DialogTitle>{url ? '링크를 만들었습니다' : '새 접속 링크'}</DialogTitle><DialogDescription>{url ? '주소는 지금 한 번만 보입니다. 닫기 전에 복사하세요.' : '링크를 가진 쪽은 대상 세션이 가진 도구로 일을 시킬 수 있습니다. 폐기해도 이미 받은 요청의 작업은 이어집니다.'}</DialogDescription></DialogHeader>
        {url ? <DialogPanel><p className="owned-agents-token" data-v3-selectable-content="true">{url}</p><p className="access-links-hint" data-v3-selectable-content="true">외부 에이전트에게 이 주소만 주면 됩니다. 주소를 열면 쓰는 법이 나옵니다.</p>{copyError && <SettingsAlert><span data-v3-selectable-content="true">복사하지 못했습니다. 주소를 직접 골라 복사하세요.</span></SettingsAlert>}</DialogPanel>
          : <DialogPanel className="access-links-form">
            <div><CatalogSelectionField className="access-links-field" label="대상 세션" ariaLabel="대상 세션" triggerRef={targetButton} triggerClassName={!target ? 'text-muted-foreground' : undefined} value={target} selectedLabel={sessionsState === 'loading' ? '불러오는 중…' : target === manual ? '세션 ID 직접 입력' : names.get(target) ?? '세션을 고르세요'} disabled={busy || sessionsState === 'loading'} invalid={targetError && target !== manual} options={[...sessions.map(session => ({ value: session.session_id, label: sessionName(session) })), { value: manual, label: '세션 ID 직접 입력', separatorBefore: sessions.length > 0 }]} onValueChange={value => { setTarget(value); setTargetError(false); focusManual.current = value === manual; }} onOpenChangeComplete={open => { if (!open && focusManual.current) { focusManual.current = false; manualInput.current?.focus(); } }} message={targetError && target !== manual ? '이 세션을 찾지 못했거나 열 수 없습니다.' : sessionsState === 'error' ? '영구 세션 목록을 불러오지 못했습니다.' : undefined}/>
              {target === manual && <div className="access-links-manual"><Input ref={manualInput} aria-label="세션 ID" aria-invalid={targetError || (idTouched && !uuid.test(manualId.trim())) || undefined} value={manualId} disabled={busy} onChange={e => { setManualId(e.target.value); setTargetError(false); }} onBlur={() => setIdTouched(true)}/>{targetError ? <small role="alert">이 세션을 찾지 못했거나 열 수 없습니다.</small> : idTouched && !uuid.test(manualId.trim()) && <small role="alert">세션 ID 형식이 아닙니다.</small>}</div>}
            </div>
            <SettingsField label="발신자 이름"><Input aria-label="발신자 이름" maxLength={80} value={label} disabled={busy} onChange={e => setLabel(e.target.value)}/></SettingsField>
            <CatalogSelectionField className="access-links-field" label="기간" ariaLabel="기간" value={duration} selectedLabel={durations.find(item => item.value === duration)?.label} options={durations} disabled={busy} onValueChange={setDuration}/>
            <fieldset><legend className="text-sm text-muted-foreground">권한</legend><div className="-mx-2">{permissions.map(item => <label key={item.value} className="flex items-start gap-2 rounded-floor px-2 py-1.5 text-sm hover:bg-muted/40"><Checkbox className="mt-0.5" checked={selected.includes(item.value)} disabled={busy} onCheckedChange={checked => setSelected(current => checked ? [...current, item.value] : current.filter(value => value !== item.value))}/><span className="access-links-permission">{item.label}{item.description && <small>{item.description}</small>}</span></label>)}</div>{!selected.length && <small role="alert">하나 이상 고르세요.</small>}</fieldset>
            {error && <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{error}</span></SettingsAlert>}
          </DialogPanel>}
        <DialogFooter>{url ? <><Button variant="outline" onClick={closeEditor}>닫기</Button><Button ref={copyButton} onClick={() => { void navigator.clipboard.writeText(url).then(() => { setCopied(true); setCopyError(false); }).catch(() => { setCopied(false); setCopyError(true); }); }}>{copied ? '복사됨' : '복사'}</Button></> : <><Button variant="outline" disabled={busy} onClick={closeEditor}>취소</Button><Button disabled={!busy && (!target || (target === manual && !manualId.trim()) || !label.trim() || !selected.length)} className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void issue()}>{busy ? '만드는 중…' : '링크 만들기'}</Button></>}</DialogFooter>
      </DialogPopup>
    </Dialog>
    <Dialog open={revoking !== null} onOpenChange={open => { if (!open && !busy) { returnRevokeFocus.current = revoking?.id ?? ''; setRevoking(null); } }} onOpenChangeComplete={open => { if (!open) (revokeButtons.current.get(returnRevokeFocus.current) ?? createButton.current)?.focus(); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }} initialFocus={cancelRevoke} finalFocus={() => revokeButtons.current.get(returnRevokeFocus.current) ?? createButton.current}><DialogHeader><DialogTitle>링크 폐기</DialogTitle><DialogDescription className="access-links-revoke-description">“{revoking?.label}”의 새 요청을 바로 막습니다. 이미 받은 요청의 작업은 이어집니다.</DialogDescription></DialogHeader>
        {revokeError && <DialogPanel><SettingsAlert><span data-v3-selectable-content="true">지금은 폐기하지 못했습니다. 다시 시도하세요.</span></SettingsAlert></DialogPanel>}
        <DialogFooter><Button ref={cancelRevoke} variant="outline" disabled={busy} onClick={() => { returnRevokeFocus.current = revoking?.id ?? ''; setRevoking(null); }}>취소</Button><Button variant="destructive" className={busyButtonClassName} aria-disabled={busy || undefined} onClick={() => void revoke()}>{busy ? '폐기 중…' : '폐기'}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  </div>;
}
