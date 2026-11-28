import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { SettingFieldWidget } from "./config/SettingFieldWidget";

type Metadata = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKeyConfigured: boolean; version: number };
const FIELDS = [
  ["endpoint", "Endpoint", "admin.storage.endpointHint"],
  ["bucket", "Bucket", "admin.storage.bucketHint"],
  ["accessKeyId", "Access Key ID", "admin.storage.accessKeyIdHint"],
  ["secretAccessKey", "Secret Access Key", "admin.storage.secretAccessKeyHint"],
] as const;

export function FileStorageTab({ request = fetch }: { request?: typeof fetch } = {}) {
  const { t } = useTranslation();
  return <div className="space-y-4" data-testid="file-storage-tab">
    <p className="text-xs text-muted-foreground">{t("admin.storage.description")}</p>
    <StorageSection request={request} purpose="board" title={t("admin.storage.board")} />
    <StorageSection request={request} purpose="attachment" title={t("admin.storage.attachments")} />
  </div>;
}
function StorageSection({ purpose, title, request }: { request: typeof fetch; purpose: "board" | "attachment"; title: string }) {
  const { t } = useTranslation();
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
    catch { setError(t("admin.storage.loadError")); }
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
      if (response.status === 409) { await load(); setMessage(t("admin.storage.conflict")); return; }
      if (!response.ok) { const body = await response.json(); throw new Error(body?.detail?.error?.message || t("admin.storage.saveError")); }
      accept(await response.json() as Metadata); setMessage(t("admin.storage.saved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("admin.storage.saveError")); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError(null); setMessage(null);
    try { const response = await request(`${endpoint}/check`, { method: "POST", credentials: "same-origin" }); if (!response.ok) throw new Error(); const body = await response.json(); setMessage(body.message); }
    catch { setError(t("admin.storage.checkError")); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-floor border border-border p-4" aria-label={title} aria-busy={busy}>
    <h3 className="text-sm font-semibold">{title}</h3>
    <div className="space-y-2">
      {FIELDS.map(([key, label, descriptionKey]) => <SettingFieldWidget key={key} field={{ key: `${purpose}-${key}`, field_name: key, label, description: t(descriptionKey),
        value: null, value_type: "str", sensitive: key === "secretAccessKey", hot_reloadable: true, read_only: busy || !metadata || (key === "secretAccessKey" && deleteSecret) }}
        value={draft[key]} onChange={value => setDraft(current => ({ ...current, [key]: value }))} />)}
    </div>
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span data-v3-selectable-content="true">{t("admin.storage.keyStatus", { status: t(metadata?.secretAccessKeyConfigured ? "admin.storage.keySaved" : "admin.storage.keyUnset") })}</span>
      <label className="flex items-center gap-2"><input type="checkbox" checked={deleteSecret} disabled={busy || !metadata?.secretAccessKeyConfigured} onChange={event => setDeleteSecret(event.target.checked)} />{t("admin.storage.deleteKey")}</label>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !metadata} onClick={() => void save()}>{t("admin.storage.save")}</Button>
      <Button size="sm" variant="outline" disabled={busy || !metadata} onClick={() => void check()}>{t("admin.storage.check")}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{t("admin.storage.reload")}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t("admin.storage.checkHint")}</p>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="text-xs text-destructive-foreground" data-v3-selectable-content="true">{error}</p>}
  </section>;
}
