import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle, FrameLoading } from "@seosoyoung/soul-ui";
import { createMcpApi, McpApiError, type McpConfig, type McpPreviewResult } from "../../lib/mcp-api";
import { DetailTabs } from "../../v3/DetailTabs";
import { inputClassName } from "../AgentAtomContextFields";
import { SettingsAlert, SettingsField, SettingsGroupBox } from "../config/SettingsListDetail";
import { McpIconTile, McpServerIcons } from "./McpIcons";

function message(error: unknown, preview = false): string {
  if (error instanceof McpApiError) {
    if (error.code.endsWith("_VERSION_CONFLICT") || error.code === "MCP_REVISION_CONFLICT") return "다른 곳에서 변경됐습니다. 다시 읽은 뒤 저장해 주세요.";
    if (preview && [403, 404, 503].includes(error.status)) return error.status === 503 ? `노드 연결 또는 기능을 확인해 주세요. ${error.message}` : error.message;
    if (error.status === 400) return "입력한 연결을 확인해 주세요.";
    if (error.status === 409) return "연결을 저장할 수 없습니다. 다시 읽은 뒤 확인해 주세요.";
  }
  return "요청에 실패했습니다. 다시 시도해 주세요.";
}

export function AgentMcpConnectionPane({ agentId, nodeId, request = fetch, onEditProfile }: {
  agentId: string; nodeId: string; request?: typeof fetch; onEditProfile(profileId: string): void;
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
  const [forkOpen, setForkOpen] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
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
    if (!config || !nodeId) { setPreview(null); return; }
    let active = true;
    setLoadingPreview(true); setPreviewError(""); setPreview(null);
    const override = profileId && profileId !== (binding?.mcp_profile_id ?? "") ? profileId : undefined;
    void api.previewAgentMcp(agentId, nodeId, override).then(result => {
      if (active) { setPreview(result); if (!result.isolation_enabled) setVariant("normal"); }
    }).catch(caught => { if (active) setPreviewError(message(caught, true)); }).finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [api, agentId, nodeId, profileId, binding?.mcp_profile_id, config?.current_revision]);
  const save = async (fork = false) => {
    if (!config) return;
    setBusy(true); setError("");
    try {
      await api.setAgentMcpBinding(agentId, { node_ids: profileId ? nodes : [nodeId], mcp_profile_id: profileId || null,
        ...(binding ? { expected_version: binding.version } : {}), expected_revision: config.current_revision, ...(fork ? { fork: true } : {}) });
      setForkOpen(false);
      await load();
    } catch (caught) { setError(message(caught)); setForkOpen(false); }
    finally { setBusy(false); }
  };
  if (!config) return error ? <SettingsAlert>{error} <Button variant="outline" onClick={() => void load().catch(caught => setError(message(caught)))}>다시 읽기</Button></SettingsAlert> : <FrameLoading inline label="MCP 설정을 불러오는 중…" />;
  const profile = config.profiles.find(item => item.id === profileId);
  const others = config.bindings.filter(item => item.mcp_profile_id === profileId && item.agent_id !== agentId);
  const current = preview?.[variant];
  return <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
    {managed ? <SettingsGroupBox title={`에이전트 MCP 연결 (${nodeId})`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1"><SettingsField label="MCP 프로필"><select className={inputClassName} value={profileId} onChange={event => setProfileId(event.target.value)}>
            <option value="">연결 안 함</option>{config.profiles.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select></SettingsField></div>
          <Button type="button" disabled={busy} onClick={() => void save()}>연결 저장</Button>
          {profile ? <Button type="button" variant="outline" onClick={() => onEditProfile(profile.id)}>이 프로필 편집</Button> : null}
        </div>
        {profile ? <><span className="sm:hidden"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} /></span><span className="hidden sm:block"><McpServerIcons ids={profile.mcp_servers} servers={config.servers} limit={profile.mcp_servers.length} /></span></> : null}
        <div><p className="mb-2 text-sm text-muted-foreground">함께 적용할 노드</p><div className="flex flex-wrap gap-3">{config.managed_nodes.map(node => <label key={node.node_id} className="flex items-center gap-2 text-sm"><Checkbox checked={node.node_id === nodeId || Boolean(profileId && nodes.includes(node.node_id))} disabled={node.node_id === nodeId || !profileId} onCheckedChange={checked => setNodes(current => checked ? [...current, node.node_id] : current.filter(id => id !== node.node_id))} />{node.node_id}</label>)}</div></div>
        {profile ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span data-v3-selectable-content="true">{others.length ? `같은 프로필 사용: ${others.map(item => `${item.agent_id} (${item.node_id})`).join(", ")}` : "이 에이전트만 사용하는 프로필입니다."}</span>{others.length ? <Button type="button" variant="outline" onClick={() => setForkOpen(true)}>이 에이전트 전용으로 분리</Button> : null}</div> : null}
        {error ? <SettingsAlert>{error}{error.includes("다시 읽은") ? <Button type="button" variant="outline" onClick={() => void load().catch(caught => setError(message(caught)))}>다시 읽기</Button> : null}</SettingsAlert> : null}
      </div>
    </SettingsGroupBox> : <p data-v3-selectable-content="true">이 노드는 중앙 MCP 관리 목록에 없습니다.</p>}
    <SettingsGroupBox title={`선택 노드 실행 미리보기 (${nodeId})`}>
      <div className="space-y-3">
        {loadingPreview ? <FrameLoading inline label="미리보기를 불러오는 중…" /> : previewError ? <SettingsAlert>{previewError}</SettingsAlert> : preview && current ? <>
          {preview.isolation_enabled ? <DetailTabs<"normal" | "restricted"> id="agent-mcp-variant" label="세션 종류" panelId="agent-mcp-preview" tabs={[["normal", "일반 세션"], ["restricted", "격리 세션"]] as const} value={variant} onChange={setVariant} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{preview.default_preset ? `기본 프리셋: ${preview.default_preset}` : "기본 프리셋 없음"} · {preview.effective_backend}</span><Badge variant={preview.applied_mode === "central" && preview.applied_revision === preview.current_revision ? "success" : "warning"} size="sm">{preview.applied_mode !== "central" ? "로컬 설정 사용 중" : preview.applied_revision !== preview.current_revision ? `이 노드는 판 ${preview.applied_revision} 사용 중 (최신 판 ${preview.current_revision})` : `중앙 판 ${preview.applied_revision} 일치`}</Badge></div>
          <div id="agent-mcp-preview" role="tabpanel" aria-label="실행 미리보기">
            {!current.runnable ? <SettingsAlert>{current.blocked_reason ?? "실행할 수 없습니다."}</SettingsAlert> : <div className="space-y-2">{current.servers.map(row => <div key={row.server_id} className="flex flex-wrap items-center justify-between gap-2 rounded-floor border border-border p-2 text-sm"><span className="flex min-w-0 items-center gap-2"><McpIconTile id={row.server_id} icon={row.icon ?? null} small /><span className="min-w-0 break-words"><strong>{row.name}</strong> <span className="text-muted-foreground">{row.type}</span></span></span><span className="flex flex-wrap items-center gap-2">{row.node_override ? <Badge size="sm">노드 덮어쓰기 적용</Badge> : null}{variant === "restricted" && row.server_id === "soulstream" ? <Badge size="sm">격리 필수</Badge> : null}<Badge variant={row.included ? "success" : "warning"} size="sm">{row.included ? "포함" : "제외"}</Badge>{!row.included && row.excluded_reason ? <span className="text-muted-foreground">{row.excluded_reason}</span> : null}</span></div>)}</div>}
          </div>
        </> : null}
      </div>
    </SettingsGroupBox>
    <Dialog open={forkOpen} onOpenChange={open => setForkOpen(open)} onOpenChangeComplete={open => { if (!open) forkSnapshot.current = ""; }}><DialogPopup className="approved-dialog" initialFocus={cancelButton}><DialogHeader><DialogTitle>프로필 분리</DialogTitle><DialogDescription>{forkOpen ? profileId : forkSnapshot.current} 프로필을 복사해 선택한 노드의 이 에이전트에 연결할까요?</DialogDescription></DialogHeader><DialogFooter><Button ref={cancelButton} type="button" variant="outline" onClick={() => setForkOpen(false)}>취소</Button><Button type="button" disabled={busy} onClick={() => void save(true)}>분리</Button></DialogFooter></DialogPopup></Dialog>
  </div>;
}
