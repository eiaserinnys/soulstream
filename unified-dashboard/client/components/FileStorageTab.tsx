import { useEffect, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { SettingFieldWidget } from "./config/SettingFieldWidget";

type Metadata = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKeyConfigured: boolean; version: number };
const FIELDS = [
  ["endpoint", "Endpoint", "Cloudflare R2 S3 API Endpoint"],
  ["bucket", "Bucket", "비공개 버킷 이름"],
  ["accessKeyId", "Access Key ID", "R2 API 접근 키 ID"],
  ["secretAccessKey", "Secret Access Key", "비워 두면 기존 키를 유지합니다"],
] as const;

export function FileStorageTab({ request = fetch }: { request?: typeof fetch } = {}) {
  return <div className="space-y-4" data-testid="file-storage-tab">
    <p className="text-xs text-muted-foreground">파일을 보관할 비공개 R2 버킷의 접속 정보를 설정합니다.</p>
    <StorageSection request={request} purpose="board" title="보드 파일" />
    <StorageSection request={request} purpose="attachment" title="세션 첨부" />
  </div>;
}
function StorageSection({ purpose, title, request }: { request: typeof fetch; purpose: "board" | "attachment"; title: string }) {
  const endpoint = `/api/admin/settings/${purpose}-r2`;
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [draft, setDraft] = useState({ endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" });
  const [deleteSecret, setDeleteSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  function accept(next: Metadata) {
    setMetadata(next); setDraft({ endpoint: next.endpoint, bucket: next.bucket, accessKeyId: next.accessKeyId, secretAccessKey: "" }); setDeleteSecret(false);
  }
  async function load() {
    setBusy(true); setError(null);
    try { const response = await request(endpoint, { credentials: "same-origin" }); if (!response.ok) throw new Error(); accept(await response.json() as Metadata); }
    catch { setError("설정을 불러오지 못했습니다."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [endpoint]);
  async function save() {
    if (!metadata || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await request(endpoint, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: draft.endpoint, bucket: draft.bucket, accessKeyId: draft.accessKeyId, expectedVersion: metadata.version,
          ...(deleteSecret ? { secretAccessKey: "" } : draft.secretAccessKey ? { secretAccessKey: draft.secretAccessKey } : {}) }) });
      if (response.status === 409) { await load(); setMessage("다른 관리자가 저장한 최신 설정을 불러왔습니다. 다시 확인해 주세요."); return; }
      if (!response.ok) { const body = await response.json(); throw new Error(body?.detail?.error?.message || "설정을 저장하지 못했습니다."); }
      accept(await response.json() as Metadata); setMessage("설정을 저장했습니다. 바로 적용됩니다.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "설정을 저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError(null); setMessage(null);
    try { const response = await request(`${endpoint}/check`, { method: "POST", credentials: "same-origin" }); if (!response.ok) throw new Error(); const body = await response.json(); setMessage(body.message); }
    catch { setError("연결을 확인하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={title} aria-busy={busy}>
    <h3 className="text-sm font-semibold">{title}</h3>
    <div className="space-y-2">
      {FIELDS.map(([key, label, description]) => <SettingFieldWidget key={key} field={{ key: `${purpose}-${key}`, field_name: key, label, description,
        value: null, value_type: "str", sensitive: key === "secretAccessKey", hot_reloadable: true, read_only: busy || !metadata || (key === "secretAccessKey" && deleteSecret) }}
        value={draft[key]} onChange={value => setDraft(current => ({ ...current, [key]: value }))} />)}
    </div>
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span>비밀키: {metadata?.secretAccessKeyConfigured ? "저장됨" : "미설정"}</span>
      <label className="flex items-center gap-2"><input type="checkbox" checked={deleteSecret} disabled={busy || !metadata?.secretAccessKeyConfigured} onChange={event => setDeleteSecret(event.target.checked)} />저장된 비밀키 삭제</label>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !metadata} onClick={() => void save()}>저장</Button>
      <Button size="sm" variant="outline" disabled={busy || !metadata} onClick={() => void check()}>연결 확인</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>다시 불러오기</Button>
    </div>
    <p className="text-xs text-muted-foreground">연결 확인은 저장된 설정으로 버킷 접근을 확인합니다.</p>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="text-xs text-accent-red">{error}</p>}
  </section>;
}
