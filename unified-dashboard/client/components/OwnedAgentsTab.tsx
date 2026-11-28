import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, FrameLoading, Input, Switch, type OwnedAgent, type OwnedAgentKey, type OwnedAgentsResponse } from '@seosoyoung/soul-ui';
import type { WebhookTranslate } from '../lib/webhooks-api';
import { createOwnedAgentsApi } from '../lib/owned-agents-api';
import './config/owned-agents.css';

export function OwnedAgentsTab({ request = fetch }: { request?: typeof fetch }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const api = useMemo(() => createOwnedAgentsApi(request, t), [request, t]);
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
    } catch (cause) { if (alive.current) setError(message(cause, t)); }
    finally { if (alive.current) setLoading(false); }
  }, [api, t]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  async function mutate(operation: () => Promise<void>, onError = setError) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onError(null);
    try { await operation(); } catch (cause) { if (alive.current) onError(message(cause, t)); }
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
    <div className="owned-agents-actions"><Button onClick={() => { setEditorError(null); setEditor({ id: null, name: '' }); }} disabled={busy}>{t('webhooks.owned.add')}</Button></div>
    {loading && <FrameLoading inline label={t('webhooks.common.loadingProgress')} />}
    {error && <div role="alert"><p className="text-destructive-foreground" data-v3-selectable-content="true">{error}</p><Button variant="outline" disabled={busy} onClick={() => void load()}>{t('webhooks.common.retry')}</Button></div>}
    {existing && <div className="owned-agents-block">
      {existing.canRegister ? <><p>{t('webhooks.owned.registerHelp')}</p><Button variant="outline" disabled={busy} onClick={() => void mutate(async () => { await api.registerExisting(); await load(); })}>{t('webhooks.owned.registerExisting')}</Button></> : <p>{existing.registered ? t('webhooks.owned.registered') : existing.configured ? t('webhooks.owned.adminRegistration') : t('webhooks.owned.noConnection')}</p>}
    </div>}
    {data?.agents.length === 0 && <p>{t('webhooks.owned.empty')}</p>}
    {data?.agents.map(agent => <div key={agent.id} className="owned-agents-block">
      <div className="owned-agents-row">
        <Button className="owned-agents-name" variant="ghost" aria-pressed={agent.id === selectedId} onClick={() => select(agent.id)}><span>{agent.name}</span></Button>
        <Switch aria-label={t('webhooks.owned.enableAgent', { name: agent.name })} checked={agent.enabled} disabled={busy} onCheckedChange={enabled => void mutate(async () => { await api.update(agent.id, { enabled }); await load(); })}/>
        <Button variant="outline" disabled={busy} aria-label={t('webhooks.owned.rename')} onClick={() => { closeKey(); setEditorError(null); setEditor({ id: agent.id, name: agent.name }); }}>{t('webhooks.owned.rename')}</Button>
      </div>
      {selectedId === agent.id && <div className="owned-agents-keys">
        <div className="owned-agents-row"><h3>{t('webhooks.owned.connectionKeys')}</h3><Button variant="outline" disabled={busy} onClick={() => void issue()}>{busy ? t('webhooks.owned.processing') : t('webhooks.owned.issueKey')}</Button></div>
        {!agent.keys.length && <p>{t('webhooks.owned.noKeys')}</p>}
        {agent.keys.map(key => <div key={key.id} className="owned-agents-key-row">
          <div><p data-v3-selectable-content="true">{key.revokedAt ? t('webhooks.owned.revoked') : t('webhooks.owned.available')}{key.isExistingConnection ? <> · {t('webhooks.owned.existing')}</> : null}</p><p className="owned-agents-meta" data-v3-selectable-content="true">{t('webhooks.owned.keyDates', { created: new Date(key.createdAt).toLocaleString(locale), lastUsed: key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString(locale) : t('webhooks.owned.noLastUse') })}</p></div>
          {!key.revokedAt && <Button variant="outline" disabled={busy} onClick={() => { setRevokeError(null); setRevoking({ agent, key }); }}>{t('webhooks.owned.revokeKey')}</Button>}
        </div>)}
      </div>}
    </div>)}
    <Dialog open={editor !== null} onOpenChange={open => { if (!open && !busy) setEditor(null); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }}>
        <DialogHeader><DialogTitle>{editor?.id ? t('webhooks.owned.rename') : t('webhooks.owned.add')}</DialogTitle><DialogDescription>{t('webhooks.owned.nameHelp')}</DialogDescription></DialogHeader>
        <DialogPanel><label htmlFor="owned-agent-name">{t('webhooks.owned.name')}</label><Input id="owned-agent-name" value={editor?.name ?? ''} disabled={busy} onChange={e => setEditor(current => current && { ...current, name: e.target.value })}/>{editorError && <p role="alert" className="text-destructive-foreground" data-v3-selectable-content="true">{editorError}</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>{t('webhooks.common.cancel')}</Button><Button disabled={busy || !editor?.name.trim()} onClick={() => void mutate(async () => { if (!editor) return; if (editor.id) await api.update(editor.id, { name: editor.name.trim() }); else await api.create(editor.name.trim()); if (alive.current) setEditor(null); await load(); }, setEditorError)}>{busy ? t('webhooks.owned.saving') : t('webhooks.owned.save')}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
    {token !== null && <Dialog open onOpenChange={open => { if (!open) closeKey(); }}>
      <DialogPopup className="approved-dialog"><DialogHeader><DialogTitle>{t('webhooks.owned.newKey')}</DialogTitle><DialogDescription>{t('webhooks.owned.keyOnce')}</DialogDescription></DialogHeader>
        <DialogPanel><p className="owned-agents-token" data-testid="owned-agent-token" data-v3-selectable-content="true">{token}</p>{copyError && <p role="alert" className="text-destructive-foreground" data-v3-selectable-content="true">{t('webhooks.owned.copyError')}</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" onClick={closeKey}>{t('webhooks.common.close')}</Button><Button onClick={() => { const value = token; void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setCopyError(true)); }}>{copied ? t('webhooks.common.copied') : t('webhooks.common.copy')}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>}
    <Dialog open={revoking !== null} onOpenChange={open => { if (!open && !busy) setRevoking(null); }}>
      <DialogPopup className="approved-dialog" closeProps={{ disabled: busy }}><DialogHeader><DialogTitle>{t('webhooks.owned.revokeTitle')}</DialogTitle><DialogDescription>{t('webhooks.owned.revokeHelp', { name: revoking?.agent.name ?? '' })}</DialogDescription></DialogHeader>
        <DialogPanel>{revokeError && <p role="alert" className="text-destructive-foreground" data-v3-selectable-content="true">{revokeError}</p>}</DialogPanel>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRevoking(null)}>{t('webhooks.common.cancel')}</Button><Button variant="destructive" disabled={busy} onClick={() => void mutate(async () => { if (!revoking) return; await api.revokeKey(revoking.agent.id, revoking.key.id); if (alive.current) setRevoking(null); await load(); }, setRevokeError)}>{busy ? t('webhooks.common.revoking') : t('webhooks.common.revoke')}</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  </div>;
}
function message(cause: unknown, t: WebhookTranslate) { return cause instanceof Error ? cause.message : t('webhooks.owned.requestError'); }
