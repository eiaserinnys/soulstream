import { useTranslation } from "react-i18next";
import type { createI18n } from "@soulstream/i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle, FrameLoading } from "@seosoyoung/soul-ui";
import { createMcpApi, isMcpVersionConflict, McpApiError, mcpRequestErrorText, type McpConfig, type McpPreviewResult } from "../../lib/mcp-api";
import { DetailTabs } from "../../v3/DetailTabs";
import { inputClassName } from "../AgentAtomContextFields";
import { SettingsAlert, SettingsField, SettingsGroupBox } from "../config/SettingsListDetail";
import { McpIconTile, McpServerIcons } from "./McpIcons";
import { SuccessMessage } from "./McpSettingsTab";

function message(t: ReturnType<typeof createI18n>["t"], error: unknown, preview = false): string {
  if (error instanceof McpApiError) {
    if (isMcpVersionConflict(error)) return t("mcp.saveConflict");
    if (preview && [403, 404, 503].includes(error.status)) return mcpRequestErrorText(error, t);
    if (error.status === 400) return t("mcp.checkConnectionInput");
    if (error.status === 409) return t("mcp.bindingConflict");
  }
  return t("mcp.requestFailed");
}

export function AgentMcpConnectionPane({ agentId, nodeId, request = fetch, onEditProfile, focusOnMount = false, onFocusHandled }: {
  agentId: string; nodeId: string; request?: typeof fetch; onEditProfile(profileId: string): void; focusOnMount?: boolean; onFocusHandled?(): void;
}) {
  const { t } = useTranslation();
  const api = useMemo(() => createMcpApi(request), [request]);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [profileId, setProfileId] = useState("");
  const [nodes, setNodes] = useState<string[]>([nodeId]);
  const [preview, setPreview] = useState<McpPreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [variant, setVariant] = useState<"normal" | "restricted">("normal");
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const error = failure ? message(t, failure.cause) : "";
  const [previewFailure, setPreviewFailure] = useState<{ cause: unknown } | null>(null);
  const previewError = previewFailure ? message(t, previewFailure.cause, true) : "";
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState("");
  const [retry, setRetry] = useState(0);
  const [forkOpen, setForkOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const profileSelect = useRef<HTMLSelectElement>(null);
  const forkSaved = useRef(false);
  const forkSnapshot = useRef("");
  useLayoutEffect(() => { if (forkOpen) forkSnapshot.current = profileId; }, [forkOpen, profileId]);
  const load = useCallback(async () => {
    const next = await api.config();
    setConfig(next);
    setProfileId(next.bindings.find(binding => binding.agent_id === agentId && binding.node_id === nodeId)?.mcp_profile_id ?? "");
    setNodes([nodeId]);
    setFailure(null);
  }, [api, agentId, nodeId]);
  useEffect(() => { setConfig(null); setVariant("normal"); void load().catch(caught => setFailure({ cause: caught })); }, [load]);
  const binding = config?.bindings.find(item => item.agent_id === agentId && item.node_id === nodeId);
  const managed = config?.managed_nodes.some(item => item.node_id === nodeId) ?? false;
  useEffect(() => {
    if (!config || !nodeId || !managed) { setPreview(null); setLoadingPreview(false); return; }
    if (!profileId && binding) { setPreview(null); setPreviewFailure(null); setLoadingPreview(false); return; }
    let active = true;
    setLoadingPreview(true); setPreviewFailure(null); setPreview(null);
    const override = profileId && profileId !== (binding?.mcp_profile_id ?? "") ? profileId : undefined;
    void api.previewAgentMcp(agentId, nodeId, override).then(result => {
      if (active) { setPreview(result); if (!result.isolation_enabled) setVariant("normal"); }
    }).catch(caught => { if (active) setPreviewFailure({ cause: caught }); }).finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [api, agentId, nodeId, profileId, binding?.mcp_profile_id, config?.current_revision, managed, retry]);
  useEffect(() => {
    if (!focusOnMount || !config) return;
    const id = requestAnimationFrame(() => {
      const target = managed ? profileSelect.current : document.getElementById("agent-profile-pane-mcp");
      target?.scrollIntoView?.({ block: "nearest" }); target?.focus(); onFocusHandled?.();
    });
    return () => cancelAnimationFrame(id);
  }, [focusOnMount, config, managed, onFocusHandled]);
  useEffect(() => {
    if (!busy && !forkOpen && restoreFocus) {
      saveButton.current?.focus();
      setRestoreFocus(false);
    }
  }, [busy, forkOpen, restoreFocus]);
  const save = async (fork = false) => {
    if (!config) return;
    setBusy(true); setFailure(null); setSuccess("");
    try {
      await api.setAgentMcpBinding(agentId, { node_ids: profileId ? nodes : [nodeId], mcp_profile_id: profileId || null,
        ...(binding ? { expected_version: binding.version } : {}), expected_revision: config.current_revision, ...(fork ? { fork: true } : {}) });
      await load();
      setSuccess(fork ? t("mcp.profileForked") : t("mcp.connectionSaved"));
      if (fork) setForkOpen(false);
    } catch (caught) { setFailure({ cause: caught }); if (fork) setForkOpen(false); }
    finally { if (fork) forkSaved.current = true; setRestoreFocus(true); setBusy(false); }
  };
  if (!config) return error ? <SettingsAlert>{error} <Button variant="outline" onClick={() => void load().catch(caught => setFailure({ cause: caught }))}>{t("mcp.reload")}</Button></SettingsAlert> : <FrameLoading inline label={t("mcp.loading")} />;
  if (!nodeId) return <p className="text-sm">{t("mcp.noConnectedNodes")}</p>;
  if (!managed) return <p className="text-sm" data-v3-selectable-content="true">{t("mcp.nodeNotManaged")}</p>;
  const profile = config.profiles.find(item => item.id === profileId);
  const others = config.bindings.filter(item => item.mcp_profile_id === profileId && item.agent_id !== agentId);
  const current = preview?.[variant];
  return <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
    {managed ? <SettingsGroupBox title={t("mcp.agentConnection", { node: nodeId })}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 [&>label>span]:whitespace-nowrap"><SettingsField label={t("mcp.mcpProfile")}><select ref={profileSelect} className={inputClassName.replace("h-8", "h-9 sm:h-8")} value={profileId} onChange={event => { setPreview(null); setLoadingPreview(true); setProfileId(event.target.value); setSuccess(""); }}>
            <option value="">{t("mcp.noConnection")}</option>{config.profiles.map(item => <option key={item.id} value={item.id}>{item.name && config.profiles.filter(other => other.name === item.name).length > 1 ? item.id : item.name || item.id}</option>)}
          </select></SettingsField></div>
          <Button ref={saveButton} type="button" disabled={busy} onClick={() => void save()}>{t("mcp.saveConnection")}</Button>
          {profile ? <Button type="button" variant="outline" onClick={() => onEditProfile(profile.id)}>{t("mcp.editProfile")}</Button> : null}
        </div>
        {success ? <SuccessMessage>{success}</SuccessMessage> : null}
        {profile ? <><span className="sm:hidden"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} /></span><span className="hidden sm:block"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} limit={profile.mcp_servers.length} /></span></> : null}
        <div><p className="mb-2 text-sm text-muted-foreground">{t("mcp.applyToNodes")}</p><div className="flex flex-wrap gap-3">{config.managed_nodes.map(node => <label key={node.node_id} className="flex items-center gap-2 text-sm"><Checkbox checked={node.node_id === nodeId || Boolean(profileId && nodes.includes(node.node_id))} disabled={node.node_id === nodeId || !profileId} onCheckedChange={checked => { setSuccess(""); setNodes(current => checked ? [...current, node.node_id] : current.filter(id => id !== node.node_id)); }} />{node.node_id}</label>)}</div></div>
        {profile ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="min-w-0" data-v3-selectable-content="true">{others.length ? <>{t("mcp.sameProfile")}{" "}{others.map((item, index) => <span key={`${item.agent_id}:${item.node_id}`}>{index ? " " : ""}<span className="inline-block max-w-full align-top whitespace-normal [overflow-wrap:anywhere]">{item.agent_id} ({item.node_id}){index < others.length - 1 ? "," : ""}</span></span>)}</> : t("mcp.onlyUsedByAgent")}</span>{others.length ? <Button type="button" variant="outline" onClick={() => { forkSaved.current = false; setForkOpen(true); }}>{t("mcp.forkForAgent")}</Button> : null}</div> : null}
        {error ? <SettingsAlert><span className="inline-flex flex-wrap items-center gap-2"><span>{error}</span>{failure?.cause instanceof McpApiError && (isMcpVersionConflict(failure.cause) || failure.cause.status === 409) ? <Button type="button" variant="outline" onClick={() => void load().catch(caught => setFailure({ cause: caught }))}>{t("mcp.reload")}</Button> : null}</span></SettingsAlert> : null}
      </div>
    </SettingsGroupBox> : <p data-v3-selectable-content="true">{t("mcp.nodeNotManaged")}</p>}
    <SettingsGroupBox title={t("mcp.nodePreview", { node: nodeId })}>
      <div className="space-y-3">
        {!profileId && binding ? <p className="text-sm">{t("mcp.disconnectOnSave")}</p> : loadingPreview ? <FrameLoading inline label={t("mcp.loadingPreview")} /> : previewError ? <SettingsAlert><span className="inline-flex flex-wrap items-center gap-2"><span>{previewError}</span><Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>{t("mcp.retry")}</Button></span></SettingsAlert> : preview && current ? <>
          {preview.isolation_enabled ? <DetailTabs<"normal" | "restricted"> id="agent-mcp-variant" label={t("mcp.sessionType")} panelId="agent-mcp-preview" tabs={[["normal", t("mcp.normalSession")], ["restricted", t("mcp.restrictedSession")]] as const} value={variant} onChange={setVariant} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span data-v3-selectable-content="true">{preview.default_preset ? t("mcp.defaultPreset", { preset: preview.default_preset }) : t("mcp.noDefaultPreset")}{" · "}{t("mcp.backend", { backend: preview.effective_backend })}</span><Badge variant={preview.applied_mode === "central" && preview.applied_revision === preview.current_revision ? "success" : "warning"} size="sm">{preview.applied_mode !== "central" ? t("mcp.localSettings") : preview.applied_revision !== preview.current_revision ? t("mcp.olderRevision", { applied: preview.applied_revision, current: preview.current_revision }) : t("mcp.centralRevision", { revision: preview.applied_revision })}</Badge></div>
          <div id="agent-mcp-preview" role="tabpanel" aria-label={t("mcp.preview")}>
            {!current.runnable ? <SettingsAlert>{current.blocked_reason ?? t("mcp.cannotRun")}</SettingsAlert> : <div className="space-y-2">{current.servers.map(row => <div key={row.server_id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-floor border border-border p-2 text-sm"><McpIconTile id={row.server_id} icon={row.icon ?? null} small /><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words" data-v3-selectable-content="true"><strong>{row.name}</strong> <span className="text-muted-foreground">{row.type}</span></span><span className="flex flex-wrap items-center gap-2">{row.node_override ? <Badge variant="info" size="sm">{t("mcp.nodeOverrideApplied")}</Badge> : null}{variant === "restricted" && row.server_id === "soulstream" ? <Badge variant="info" size="sm">{t("mcp.requiredForIsolation")}</Badge> : null}<Badge variant={row.included ? "success" : "warning"} size="sm">{row.included ? t("mcp.included") : t("mcp.excluded")}</Badge>{!row.included && row.excluded_reason ? <span data-v3-selectable-content="true" className="text-muted-foreground">{row.excluded_reason}</span> : null}</span></div></div>)}</div>}
          </div>
        </> : null}
      </div>
    </SettingsGroupBox>
    <Dialog open={forkOpen} onOpenChange={open => setForkOpen(open)} onOpenChangeComplete={open => { if (!open) forkSnapshot.current = ""; }}><DialogPopup className="approved-dialog" initialFocus={cancelButton} finalFocus={() => forkSaved.current ? saveButton.current : true}><DialogHeader><DialogTitle>{t("mcp.forkProfile")}</DialogTitle><DialogDescription>{t("mcp.confirmFork", { profile: forkOpen ? profileId : forkSnapshot.current })}</DialogDescription></DialogHeader><DialogFooter><Button ref={cancelButton} type="button" variant="outline" onClick={() => setForkOpen(false)}>{t("mcp.cancel")}</Button><Button type="button" disabled={busy} onClick={() => void save(true)}>{t("mcp.fork")}</Button></DialogFooter></DialogPopup></Dialog>
  </div>;
}
