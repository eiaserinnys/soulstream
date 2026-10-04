import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Input, Switch } from '@seosoyoung/soul-ui';
import { createOwnedAgentsApi, type OwnedAgent, type OwnedAgentKey, type OwnedAgentsResponse } from '../lib/owned-agents-api';
import './config/owned-agents.css';

export function OwnedAgentsTab({ request = fetch }: { request?: typeof fetch }) {
  const api = useMemo(() => createOwnedAgentsApi(request), [request]);
  const [data, setData] = useState<OwnedAgentsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<{ agent: OwnedAgent; key: OwnedAgentKey } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const selected = data?.agents.find(agent => agent.id === selectedId);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const next = await api.list();
      if (!alive.current) return;
      setData(next);
      setSelectedId(current => next.agents.some(a => a.id === current) ? current : next.agents[0]?.id ?? null);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { if (alive.current) setLoading(false); }
  }, [api]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  async function mutate(operation: () => Promise<void>, onError = setError) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onError(null);
    try { await operation(); } catch (cause) { if (alive.current) onError(message(cause)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function select(id: string) { setToken(null); setCopied(false); setCopyError(false); selection.current = id; setSelectedId(id); }
  function closeKey() { setToken(null); setCopied(false); setCopyError(false); }
  async function issue() {
    if (!selected) return;
    const id = selected.id;
    await mutate(async () => {
      const result = await api.issueKey(id);
      if (alive.current && selection.current === id) { setToken(result.token); setCopied(false); setCopyError(false); }
      await load();
    });
  }
  const existing = data?.existingConnection;
  return <div className="owned-agents">
    <div className="owned-agents-actions"><Button onClick={() => { setEditorError(null); setEditor({ id: null, name: '' }); }} disabled={busy}>에이전트 추가</Button></div>
    {loading && <p role="status">불러오는 중…</p>}
    {error && <div role="alert"><p>{error}</p><Button variant="outline" disabled={busy} onClick={() => void load()}>다시 시도</Button></div>}
    {existing && <div className="owned-agents-block">
      {existing.canRegister ? <><p>현재 연결의 주소와 키를 그대로 사용해 내 에이전트로 등록합니다.</p><Button variant="outline" disabled={busy} onClick={() => void mutate(async () => { await api.registerExisting(); await load(); })}>기존 연결 등록</Button></> : <p>{existing.registered ? '기존 연결이 등록되어 있습니다.' : existing.configured ? '기존 연결 등록은 관리자에게 요청해 주세요.' : '등록할 기존 연결이 없습니다.'}</p>}
    </div>}
    {data?.agents.length === 0 && <p>아직 등록한 에이전트가 없습니다.</p>}
    {data?.agents.map(agent => <div key={agent.id} className="owned-agents-block">
      <div className="owned-agents-row">
        <Button className="owned-agents-name" variant="ghost" aria-pressed={agent.id === selectedId} onClick={() => select(agent.id)}><span>{agent.name}</span></Button>
        <Switch aria-label={`${agent.name} 활성화`} checked={agent.enabled} disabled={busy} onCheckedChange={enabled => void mutate(async () => { await api.update(agent.id, { enabled }); await load(); })}/>
        <Button variant="outline" disabled={busy} aria-label="이름 변경" onClick={() => { closeKey(); setEditorError(null); setEditor({ id: agent.id, name: agent.name }); }}>이름 변경</Button>
      </div>
      {selectedId === agent.id && <div className="owned-agents-keys">
        <div className="owned-agents-row"><h3>연결 키</h3><Button variant="outline" disabled={busy} onClick={() => void issue()}>{busy ? '처리 중…' : '새 키 발급'}</Button></div>
        {!agent.keys.length && <p>발급한 키가 없습니다.</p>}
        {agent.keys.map(key => <div key={key.id} className="owned-agents-key-row">
          <div><p>{key.revokedAt ? '폐기됨' : '사용 가능'}{key.isExistingConnection ? ' · 기존 연결' : ''}</p><p className="owned-agents-meta">생성 {date(key.createdAt)} · 최근 사용 {key.lastUsedAt ? date(key.lastUsedAt) : '없음'}</p></div>
          {!key.revokedAt && <Button variant="outline" disabled={busy} onClick={() => { setRevokeError(null); setRevoking({ agent, key }); }}>키 폐기</Button>}
        </div>)}
      </div>}
    </div>)}
    <Dialog open={editor !== null} onOpenChange={open => { if (!open && !busy) setEditor(null); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }}>
        <DialogHeader><DialogTitle>{editor?.id ? '이름 변경' : '에이전트 추가'}</DialogTitle><DialogDescription>설정에서 알아보기 쉬운 이름을 입력하세요.</DialogDescription></DialogHeader>
        <DialogPanel><label htmlFor="owned-agent-name">에이전트 이름</label><Input id="owned-agent-name" value={editor?.name ?? ''} disabled={busy} onChange={e => setEditor(current => current && { ...current, name: e.target.value })}/>{editorError && <p role="alert">{editorError}</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>취소</Button><Button disabled={busy || !editor?.name.trim()} onClick={() => void mutate(async () => { if (!editor) return; if (editor.id) await api.update(editor.id, { name: editor.name.trim() }); else await api.create(editor.name.trim()); if (alive.current) setEditor(null); await load(); }, setEditorError)}>{busy ? '저장 중…' : '저장'}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
    {token !== null && <Dialog open onOpenChange={open => { if (!open) closeKey(); }}>
      <DialogPopup className="approved-dialog"><DialogHeader><DialogTitle>새 연결 키</DialogTitle><DialogDescription>닫으면 다시 볼 수 없습니다. 지금 복사해 안전한 곳에 보관하세요.</DialogDescription></DialogHeader>
        <DialogPanel><p className="owned-agents-token" data-testid="owned-agent-token">{token}</p>{copyError && <p role="alert">복사하지 못했습니다. 다시 복사해 주세요.</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" onClick={closeKey}>닫기</Button><Button onClick={() => { const value = token; void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setCopyError(true)); }}>{copied ? '복사됨' : '복사'}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>}
    <Dialog open={revoking !== null} onOpenChange={open => { if (!open && !busy) setRevoking(null); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }}><DialogHeader><DialogTitle>연결 키 폐기</DialogTitle><DialogDescription>{revoking?.agent.name}의 이 키를 사용하는 연결은 더 이상 요청할 수 없습니다.</DialogDescription></DialogHeader>
        <DialogPanel>{revokeError && <p role="alert">{revokeError}</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRevoking(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => void mutate(async () => { if (!revoking) return; await api.revokeKey(revoking.agent.id, revoking.key.id); if (alive.current) setRevoking(null); await load(); }, setRevokeError)}>{busy ? '폐기 중…' : '폐기'}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  </div>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.'; }
function date(value: string) { return new Date(value).toLocaleString(); }
