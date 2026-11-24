import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle, FrameLoading } from "@seosoyoung/soul-ui";
import { createMcpApi, McpApiError, mcpRequestErrorText, type McpConfig, type McpPreviewResult } from "../../lib/mcp-api";
import { DetailTabs } from "../../v3/DetailTabs";
import { inputClassName } from "../AgentAtomContextFields";
import { SettingsAlert, SettingsField, SettingsGroupBox } from "../config/SettingsListDetail";
import { McpIconTile, McpServerIcons } from "./McpIcons";
import { SuccessMessage } from "./McpSettingsTab";

function message(error: unknown, preview = false): string {
  if (error instanceof McpApiError) {
    if (error.code.endsWith("_VERSION_CONFLICT") || error.code === "MCP_REVISION_CONFLICT") return "다른 곳에서 변경됐습니다. 다시 읽은 뒤 저장해 주세요.";
    if (preview && [403, 404, 503].includes(error.status)) return mcpRequestErrorText(error);
    if (error.status === 400) return "입력한 연결을 확인해 주세요.";
    if (error.status === 409) return "연결을 저장할 수 없습니다. 다시 읽은 뒤 확인해 주세요.";
  }
  return "요청에 실패했습니다. 다시 시도해 주세요.";
}

export function AgentMcpConnectionPane({ agentId, nodeId, request = fetch, onEditProfile, focusOnMount = false, onFocusHandled }: {
  agentId: string; nodeId: string; request?: typeof fetch; onEditProfile(profileId: string): void; focusOnMount?: boolean; onFocusHandled?(): void;
}) {
  const api = useMemo(() => createMcpApi(request), [request]);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [profileId, setProfileId] = useState("");
  const [nodes, setNodes] = useState<string[]>([nodeId]);
  const [preview, setPreview] = useState<McpPreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [variant, setVariant] = useState<"normal" | "restricted">("normal");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
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
    setError("");
  }, [api, agentId, nodeId]);
  useEffect(() => { setConfig(null); setVariant("normal"); void load().catch(caught => setError(message(caught))); }, [load]);
  const binding = config?.bindings.find(item => item.agent_id === agentId && item.node_id === nodeId);
  const managed = config?.managed_nodes.some(item => item.node_id === nodeId) ?? false;
  useEffect(() => {
    if (!config || !nodeId || !managed) { setPreview(null); setLoadingPreview(false); return; }
    if (!profileId && binding) { setPreview(null); setPreviewError(""); setLoadingPreview(false); return; }
    let active = true;
    setLoadingPreview(true); setPreviewError(""); setPreview(null);
    const override = profileId && profileId !== (binding?.mcp_profile_id ?? "") ? profileId : undefined;
    void api.previewAgentMcp(agentId, nodeId, override).then(result => {
      if (active) { setPreview(result); if (!result.isolation_enabled) setVariant("normal"); }
    }).catch(caught => { if (active) setPreviewError(message(caught, true)); }).finally(() => { if (active) setLoadingPreview(false); });
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
    setBusy(true); setError(""); setSuccess("");
    try {
      await api.setAgentMcpBinding(agentId, { node_ids: profileId ? nodes : [nodeId], mcp_profile_id: profileId || null,
        ...(binding ? { expected_version: binding.version } : {}), expected_revision: config.current_revision, ...(fork ? { fork: true } : {}) });
      await load();
      setSuccess(fork ? "프로필을 분리했습니다." : "연결을 저장했습니다.");
      if (fork) setForkOpen(false);
    } catch (caught) { setError(message(caught)); if (fork) setForkOpen(false); }
    finally { if (fork) forkSaved.current = true; else setRestoreFocus(true); setBusy(false); }
  };
  if (!config) return error ? <SettingsAlert>{error} <Button variant="outline" onClick={() => void load().catch(caught => setError(message(caught)))}>다시 읽기</Button></SettingsAlert> : <FrameLoading inline label="MCP 설정을 불러오는 중…" />;
  if (!nodeId) return <p className="text-sm">연결된 노드가 없습니다.</p>;
  if (!managed) return <p className="text-sm" data-v3-selectable-content="true">이 노드는 중앙 MCP 관리 목록에 없습니다.</p>;
  const profile = config.profiles.find(item => item.id === profileId);
  const others = config.bindings.filter(item => item.mcp_profile_id === profileId && item.agent_id !== agentId);
  const current = preview?.[variant];
  return <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
    {managed ? <SettingsGroupBox title={`에이전트 MCP 연결 (${nodeId})`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 [&>label>span]:whitespace-nowrap"><SettingsField label="MCP 프로필"><select ref={profileSelect} className={inputClassName.replace("h-8", "h-9 sm:h-8")} value={profileId} onChange={event => { setPreview(null); setLoadingPreview(true); setProfileId(event.target.value); setSuccess(""); }}>
            <option value="">연결 안 함</option>{config.profiles.map(item => <option key={item.id} value={item.id}>{item.name && config.profiles.filter(other => other.name === item.name).length > 1 ? item.id : item.name || item.id}</option>)}
          </select></SettingsField></div>
          <Button ref={saveButton} type="button" disabled={busy} onClick={() => void save()}>연결 저장</Button>
          {profile ? <Button type="button" variant="outline" onClick={() => onEditProfile(profile.id)}>이 프로필 편집</Button> : null}
        </div>
        {success ? <SuccessMessage>{success}</SuccessMessage> : null}
        {profile ? <><span className="sm:hidden"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} /></span><span className="hidden sm:block"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} limit={profile.mcp_servers.length} /></span></> : null}
        <div><p className="mb-2 text-sm text-muted-foreground">함께 적용할 노드</p><div className="flex flex-wrap gap-3">{config.managed_nodes.map(node => <label key={node.node_id} className="flex items-center gap-2 text-sm"><Checkbox checked={node.node_id === nodeId || Boolean(profileId && nodes.includes(node.node_id))} disabled={node.node_id === nodeId || !profileId} onCheckedChange={checked => { setSuccess(""); setNodes(current => checked ? [...current, node.node_id] : current.filter(id => id !== node.node_id)); }} />{node.node_id}</label>)}</div></div>
        {profile ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="min-w-0" data-v3-selectable-content="true">{others.length ? <>같은 프로필 사용: {others.map((item, index) => <span key={`${item.agent_id}:${item.node_id}`}>{index ? " " : ""}<span className="inline-block max-w-full align-top whitespace-normal [overflow-wrap:anywhere]">{item.agent_id} ({item.node_id}){index < others.length - 1 ? "," : ""}</span></span>)}</> : "이 에이전트만 사용하는 프로필입니다."}</span>{others.length ? <Button type="button" variant="outline" onClick={() => setForkOpen(true)}>이 에이전트 전용으로 분리</Button> : null}</div> : null}
        {error ? <SettingsAlert><span className="inline-flex flex-wrap items-center gap-2"><span>{error}</span>{error.includes("다시 읽은") ? <Button type="button" variant="outline" onClick={() => void load().catch(caught => setError(message(caught)))}>다시 읽기</Button> : null}</span></SettingsAlert> : null}
      </div>
    </SettingsGroupBox> : <p data-v3-selectable-content="true">이 노드는 중앙 MCP 관리 목록에 없습니다.</p>}
    <SettingsGroupBox title={`선택 노드 실행 미리보기 (${nodeId})`}>
      <div className="space-y-3">
        {!profileId && binding ? <p className="text-sm">저장하면 이 노드에서 이 에이전트의 MCP 연결을 뗍니다. 연결을 뗀 뒤의 미리보기는 저장한 뒤에 볼 수 있습니다.</p> : loadingPreview ? <FrameLoading inline label="미리보기를 불러오는 중…" /> : previewError ? <SettingsAlert><span className="inline-flex flex-wrap items-center gap-2"><span>{previewError}</span><Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>다시 시도</Button></span></SettingsAlert> : preview && current ? <>
          {preview.isolation_enabled ? <DetailTabs<"normal" | "restricted"> id="agent-mcp-variant" label="세션 종류" panelId="agent-mcp-preview" tabs={[["normal", "일반 세션"], ["restricted", "격리 세션"]] as const} value={variant} onChange={setVariant} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span data-v3-selectable-content="true">{preview.default_preset ? `기본 프리셋: ${preview.default_preset}` : "기본 프리셋 없음"} · 백엔드: {preview.effective_backend}</span><Badge variant={preview.applied_mode === "central" && preview.applied_revision === preview.current_revision ? "success" : "warning"} size="sm">{preview.applied_mode !== "central" ? "로컬 설정 사용 중" : preview.applied_revision !== preview.current_revision ? `이 노드는 판 ${preview.applied_revision} 사용 중 (최신 판 ${preview.current_revision})` : `중앙 판 ${preview.applied_revision} 일치`}</Badge></div>
          <div id="agent-mcp-preview" role="tabpanel" aria-label="실행 미리보기">
            {!current.runnable ? <SettingsAlert>{current.blocked_reason ?? "실행할 수 없습니다."}</SettingsAlert> : <div className="space-y-2">{current.servers.map(row => <div key={row.server_id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-floor border border-border p-2 text-sm"><McpIconTile id={row.server_id} icon={row.icon ?? null} small /><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words" data-v3-selectable-content="true"><strong>{row.name}</strong> <span className="text-muted-foreground">{row.type}</span></span><span className="flex flex-wrap items-center gap-2">{row.node_override ? <Badge variant="info" size="sm">노드 덮어쓰기 적용</Badge> : null}{variant === "restricted" && row.server_id === "soulstream" ? <Badge variant="info" size="sm">격리 필수</Badge> : null}<Badge variant={row.included ? "success" : "warning"} size="sm">{row.included ? "포함" : "제외"}</Badge>{!row.included && row.excluded_reason ? <span data-v3-selectable-content="true" className="text-muted-foreground">{row.excluded_reason}</span> : null}</span></div></div>)}</div>}
          </div>
        </> : null}
      </div>
    </SettingsGroupBox>
    <Dialog open={forkOpen} onOpenChange={open => setForkOpen(open)} onOpenChangeComplete={open => { if (!open) { forkSnapshot.current = ""; if (forkSaved.current) { forkSaved.current = false; setRestoreFocus(true); } } }}><DialogPopup className="approved-dialog" initialFocus={cancelButton}><DialogHeader><DialogTitle>프로필 분리</DialogTitle><DialogDescription>{forkOpen ? profileId : forkSnapshot.current} 프로필을 복사해 선택한 노드의 이 에이전트에 연결할까요?</DialogDescription></DialogHeader><DialogFooter><Button ref={cancelButton} type="button" variant="outline" onClick={() => setForkOpen(false)}>취소</Button><Button type="button" disabled={busy} onClick={() => void save(true)}>분리</Button></DialogFooter></DialogPopup></Dialog>
  </div>;
}
