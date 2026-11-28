import { useTranslation } from "react-i18next";
// This file remains over 500 lines because the requested profile, portrait,
// and preview workflows stay together in one tab. Bundle rows and CRUD live
// in separate components; another split would change the planned boundary.
import { useEffect, useLayoutEffect, useMemo, useState, type ChangeEvent } from "react";
import { Button, FrameLoading, FrameNotice, useAgentPortraitDictionary, useAgentPortraitStore, useAgentPortraitUrlResolver } from "@seosoyoung/soul-ui";

import { useOrchestratorStore } from "../store/orchestrator-store";
import { DetailTabs } from "../v3/DetailTabs";
import {
  AgentAtomContextFields,
  LabeledInput,
  inputClassName,
  type AgentAtomContext,
} from "./AgentAtomContextFields";
import { AgentContextAssemblyView } from "./AgentContextAssemblyView";
import { ContextBundleEditor, type ContextBundle } from "./ContextBundleEditor";
import { ProfileOverviewMatrix } from "./guides/ProfileOverviewMatrix";
import { useExecNode } from "../lib/skill-guides";
import { AgentMcpConnectionPane } from "./mcp/AgentMcpConnectionPane";

type AgentAlias = string | { id: string; default_preset?: string };

interface AgentProfile {
  agent_id: string;
  name: string;
  context_bundles: string[];
  atom_contexts: AgentAtomContext[];
  effective_atom_contexts: AgentAtomContext[];
  default_preset: string | null;
  aliases: AgentAlias[];
  has_portrait: boolean;
  portrait: { mime: string; size: number; sha256: string } | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AliasDraft {
  id: string;
  default_preset: string;
}

interface ProfileDraft extends Omit<AgentProfile, "aliases"> {
  aliases: AliasDraft[];
}

interface NodeAgent {
  id: string;
  name: string;
  backend?: string;
  portraitUrl?: string;
  source?: "db" | "yaml";
}

type Translate = ReturnType<typeof useTranslation>["t"];

export function AgentProfileEditorTab({ request = fetch, initialMcpTarget, onEditMcpProfile }: { request?: typeof fetch; initialMcpTarget?: { agentId: string; nodeId: string }; onEditMcpProfile?: (profileId: string) => void }) {
  const { t } = useTranslation();
  const nodes = useOrchestratorStore((state) => state.nodes);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [bundles, setBundles] = useState<ContextBundle[]>([]);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [managingBundles, setManagingBundles] = useState(false);
  // 한눈에: 프로필 편집 자리 전체를 프로필과 소스의 표로 바꾼다.
  const [overview, setOverview] = useState(false);
  const [selectedBundleToAdd, setSelectedBundleToAdd] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | VersionConflictError | null>(null);
  const errorText = error instanceof VersionConflictError ? t("agents.profile.conflict") : error;
  const [portraitFile, setPortraitFile] = useState<File | null>(null);
  const [portraitPreviewUrl, setPortraitPreviewUrl] = useState<string | null>(null);
  const [removePortrait, setRemovePortrait] = useState(false);
  // 스킬 탭이 같은 노드로 쓰이는 곳을 보이도록 고른 노드는 설정 창이 열린 동안 공유한다.
  const [selectedNodeId, setSelectedNodeId] = useExecNode();
  useLayoutEffect(() => { if (initialMcpTarget?.nodeId) setSelectedNodeId(initialMcpTarget.nodeId); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodeAgents, setNodeAgents] = useState<NodeAgent[]>([]);
  const [loadedNodeId, setLoadedNodeId] = useState("");
  // 노드 설정에만 있는 프로필을 고르면 draft 대신 이 ID가 선택이다(읽기 전용).
  const [nodeProfileId, setNodeProfileId] = useState<string | null>(initialMcpTarget?.agentId ?? null);
  const [pane, setPane] = useState<"edit" | "assembly" | "mcp">(initialMcpTarget ? "mcp" : "assembly");
  const [focusMcpTarget, setFocusMcpTarget] = useState(Boolean(initialMcpTarget));
  // 초상 주소는 중앙 목록(버전 주소)에서만 만든다. 목록을 받기 전에는 저장돼 있다고 알려 준 에이전트만 보인다.
  const portraitDictionary = useAgentPortraitDictionary();
  const resolvePortrait = useAgentPortraitUrlResolver();
  const savedPortraitUrl = (agentId: string, hinted: boolean) =>
    portraitDictionary === null && !hinted ? "" : resolvePortrait(agentId);

  const connectedNodeIds = useMemo(
    () => Array.from(nodes.values())
      .filter((node) => node.status === "connected")
      .map((node) => node.nodeId),
    [nodes],
  );
  const effectiveContexts = useMemo(() => {
    if (!draft) return [];
    return [
      ...draft.context_bundles.flatMap((bundleId) => {
        const bundle = bundles.find((candidate) => candidate.bundle_id === bundleId);
        return bundle?.atom_contexts.map((context) => ({ context, source: bundleId })) ?? [];
      }),
      ...draft.atom_contexts.map((context) => ({ context, source: t("agents.profile.label") })),
    ];
  }, [draft, bundles, t]);

  useEffect(() => {
    if (!portraitFile) {
      setPortraitPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(portraitFile);
    setPortraitPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [portraitFile]);

  useEffect(() => {
    if (!selectedNodeId || (!connectedNodeIds.includes(selectedNodeId) && selectedNodeId !== initialMcpTarget?.nodeId)) {
      setSelectedNodeId(connectedNodeIds[0] ?? "");
    }
  }, [connectedNodeIds, selectedNodeId, initialMcpTarget?.nodeId]);

  useEffect(() => {
    if (!selectedNodeId) { setNodeAgents([]); setLoadedNodeId(""); return; }
    setLoadedNodeId("");
    let alive = true;
    void (async () => {
      try {
        const response = await request(`/api/nodes/${encodeURIComponent(selectedNodeId)}/agents`, { credentials: "same-origin" });
        const body = await responseJson(response);
        if (alive) { setNodeAgents(response.ok && Array.isArray(body.agents) ? body.agents as NodeAgent[] : []); setLoadedNodeId(selectedNodeId); }
      } catch {
        if (alive) { setNodeAgents([]); setLoadedNodeId(selectedNodeId); }
      }
    })();
    return () => { alive = false; };
  }, [request, selectedNodeId]);

  const nodeOnlyProfiles = useMemo(
    () => loadedNodeId === selectedNodeId ? nodeAgents.filter((agent) => agent.source === "yaml") : [],
    [nodeAgents, loadedNodeId, selectedNodeId],
  );
  useEffect(() => {
    if (loadedNodeId === selectedNodeId && nodeProfileId && !nodeOnlyProfiles.some((agent) => agent.id === nodeProfileId) && !(nodeProfileId === initialMcpTarget?.agentId && selectedNodeId === initialMcpTarget.nodeId)) setNodeProfileId(null);
  }, [nodeOnlyProfiles, nodeProfileId, loadedNodeId, selectedNodeId, initialMcpTarget]);
  const selectedNodeProfile: NodeAgent | null = nodeOnlyProfiles.find((agent) => agent.id === nodeProfileId)
    ?? (nodeProfileId && nodeProfileId === initialMcpTarget?.agentId && selectedNodeId === initialMcpTarget.nodeId ? { id: nodeProfileId, name: nodeProfileId, source: "yaml" as const } : null);
  const assemblyAgentId = selectedNodeProfile?.id ?? draft?.agent_id ?? "";
  const nodeAgent = nodeAgents.find((agent) => agent.id === assemblyAgentId) ?? null;

  const loadProfiles = async (preferredAgentId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const [response, nextBundles] = await Promise.all([
        request("/api/agent-profiles", { credentials: "same-origin" }),
        fetchBundles(request, t),
      ]);
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, t("agents.profile.loadError")));
      const nextProfiles = Array.isArray(body.profiles) ? body.profiles as AgentProfile[] : [];
      setProfiles(nextProfiles);
      setBundles(nextBundles);
      const preferred = nextProfiles.find((profile) => profile.agent_id === preferredAgentId);
      const selected = preferred ?? (initialMcpTarget && preferredAgentId === initialMcpTarget.agentId ? null : nextProfiles[0] ?? null);
      setDraft(selected ? profileDraft(selected) : null);
      if (initialMcpTarget && preferredAgentId === initialMcpTarget.agentId) setNodeProfileId(preferred ? null : initialMcpTarget.agentId);
      setSelectedBundleToAdd("");
      setPortraitFile(null);
      setRemovePortrait(false);
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setLoading(false);
    }
  };

  const refreshBundles = async () => {
    setBundles(await fetchBundles(request, t));
    setSelectedBundleToAdd("");
  };

  useEffect(() => {
    void loadProfiles(initialMcpTarget?.agentId);
  }, []);

  const selectNodeProfile = (agentId: string) => {
    setNodeProfileId(agentId);
    setMessage(null);
    setError(null);
    setPortraitFile(null);
    setRemovePortrait(false);
  };

  const selectProfile = (profile: AgentProfile) => {
    setDraft(profileDraft(profile));
    setNodeProfileId(null);
    setSelectedBundleToAdd("");
    setMessage(null);
    setError(null);
    setPortraitFile(null);
    setRemovePortrait(false);
  };

  const startProfile = () => {
    const now = new Date().toISOString();
    setDraft({
      agent_id: "",
      name: "",
      context_bundles: [],
      atom_contexts: [],
      effective_atom_contexts: [],
      default_preset: null,
      aliases: [],
      has_portrait: false,
      portrait: null,
      version: 0,
      created_at: now,
      updated_at: now,
    });
    setSelectedBundleToAdd("");
    setMessage(null);
    setError(null);
    setPortraitFile(null);
    setRemovePortrait(false);
    setNodeProfileId(null);
    setPane("edit");
  };

  const save = async () => {
    if (!draft || !draft.agent_id.trim() || !draft.name.trim()) {
      setError(t("agents.profile.required"));
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      let current = await putProfile(draft, request, t);
      setDraft(profileDraft(current));

      if (portraitFile) {
        current = withPortrait(current, await putPortrait(current.agent_id, portraitFile, request, t));
        await useAgentPortraitStore.getState().refresh();
      } else if (removePortrait && savedPortraitUrl(current.agent_id, current.has_portrait)) {
        await deletePortrait(current.agent_id, request, t);
        current = withPortrait(current, null);
        await useAgentPortraitStore.getState().refresh();
      }

      setProfiles((previous) => upsertProfile(previous, current));
      setDraft(profileDraft(current));
      setPortraitFile(null);
      setRemovePortrait(false);
      setMessage(JSON.stringify(current.effective_atom_contexts.map(({ node_id }) => node_id))
        === JSON.stringify(effectiveContexts.map(({ context }) => context.node_id))
        ? t("agents.profile.saved")
        : t("agents.profile.savedOrderChanged"));
    } catch (caught) {
      if (caught instanceof VersionConflictError) {
        setError(caught);
      } else {
        setError(errorMessage(caught, t));
      }
    } finally {
      setSaving(false);
    }
  };

  // 노드 설정에만 있는 에이전트는 프로필 행이 없다. 초상만 중앙 저장소에 올리거나 지운다.
  const saveNodePortrait = async (agentId: string) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (portraitFile) await putPortrait(agentId, portraitFile, request, t);
      else if (removePortrait) await deletePortrait(agentId, request, t);
      await useAgentPortraitStore.getState().refresh();
      setPortraitFile(null);
      setRemovePortrait(false);
      setMessage(t("agents.portrait.saved"));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <FrameLoading label={t("agents.profile.loading")} />;
  // 첫 읽기 실패: 편집 영역 안의 오류 줄만 남기지 않고, 로더와 같은 자리에서
  // 실패 안내를 보여 준다. 프로필이 이미 있으면 종전처럼 편집기 안 오류 줄을 쓴다.
  if (error && profiles.length === 0 && !draft) {
    return <FrameNotice><p role="alert" className="rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">{errorText}</p></FrameNotice>;
  }

  return (
    <div data-testid="agent-profile-settings" className="sm:flex sm:min-h-0 sm:flex-1 sm:flex-col">
      {/* 설정 창이 한 칸이 되는 좁은 폭(40rem 미만)에서는 프로필 목록 대신 위쪽 선택 칸으로 고른다. */}
      <div className="mb-2 grid grid-cols-2 items-end gap-2 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-0">
        {managingBundles ? <span /> : (
          <label className="text-xs font-medium">
            {t("agents.assignment.executionNode")}
            <select aria-label={t("agents.assignment.executionNode")} className={inputClassName} value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.target.value)}>
              {connectedNodeIds.length === 0 && <option value="">{t("agents.assignment.noNodesOption")}</option>}
              {selectedNodeId && !connectedNodeIds.includes(selectedNodeId) && <option value={selectedNodeId}>{selectedNodeId}</option>}
              {connectedNodeIds.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
            </select>
          </label>
        )}
        {!managingBundles && !overview && (
          <label className="min-w-0 text-xs font-medium sm:hidden">
            {t("agents.profile.label")}
            <select
              aria-label={t("agents.profile.label")}
              className={inputClassName}
              value={selectedNodeProfile ? `node:${selectedNodeProfile.id}` : draft?.version ? `central:${draft.agent_id}` : ""}
              onChange={(event) => {
                const [kind, id] = event.target.value.split(/:(.*)/s);
                if (kind === "node") selectNodeProfile(id!);
                const profile = profiles.find((candidate) => candidate.agent_id === id);
                if (kind === "central" && profile) selectProfile(profile);
              }}
            >
              {!draft?.version && !selectedNodeProfile && <option value="">{t("agents.profile.new")}</option>}
              {profiles.map((profile) => <option key={profile.agent_id} value={`central:${profile.agent_id}`}>{profile.name}</option>)}
              {selectedNodeProfile && !nodeOnlyProfiles.some((agent) => agent.id === selectedNodeProfile.id) && (
                <option value={`node:${selectedNodeProfile.id}`}>{selectedNodeProfile.name}</option>
              )}
              {nodeOnlyProfiles.length > 0 && (
                <optgroup label={t("agents.profile.nodeSettings")}>
                  {nodeOnlyProfiles.map((agent) => <option key={agent.id} value={`node:${agent.id}`}>{agent.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        )}
        <div className="col-span-2 flex flex-wrap justify-end gap-2 sm:col-span-1">
          {!managingBundles && !overview && <Button type="button" size="sm" variant="outline" className="sm:hidden" onClick={startProfile}>{t("agents.profile.new")}</Button>}
          {!managingBundles && <Button type="button" size="sm" variant="outline" onClick={() => setOverview(!overview)}>
            {overview ? t("agents.profile.backToEdit") : t("agents.profile.overview")}
          </Button>}
          {!overview && <Button type="button" size="sm" variant="outline" onClick={() => setManagingBundles(!managingBundles)}>
            {managingBundles ? t("agents.profile.backToEdit") : t("agents.bundle.manage")}
          </Button>}
        </div>
      </div>
      {overview ? (
        !selectedNodeId ? <FrameNotice>{t("agents.assignment.noNodes")}</FrameNotice> : <ProfileOverviewMatrix nodeId={selectedNodeId} request={request} />
      ) : managingBundles ? (
        <ContextBundleEditor request={request} bundles={bundles} onBundlesChanged={refreshBundles} />
      ) : (
    <div className="grid h-[520px] min-h-0 grid-cols-1 overflow-hidden rounded-floor border border-border sm:h-auto sm:flex-1 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-muted/20 p-2 max-sm:hidden">
        <Button type="button" size="sm" variant="outline" className="mb-2 w-full" onClick={startProfile}>
          {t("agents.profile.new")}
        </Button>
        {profiles.map((profile) => {
          const listPortraitUrl = savedPortraitUrl(profile.agent_id, profile.has_portrait);
          return (
          <button
            key={profile.agent_id}
            type="button"
            className={`mb-1 flex w-full items-center gap-2 rounded-floor px-3 py-2 text-left text-sm ${!selectedNodeProfile && draft?.agent_id === profile.agent_id ? "bg-accent-blue/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => selectProfile(profile)}
          >
            {listPortraitUrl ? (
              <img src={listPortraitUrl} alt={profile.name} className="h-8 w-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground" aria-hidden="true">
                {profile.name.charAt(0)}
              </span>
            )}
            <span className="min-w-0">
              <span className="block font-semibold">{profile.name}</span>
              <span className="block truncate text-xs">{profile.agent_id} · v{profile.version}</span>
            </span>
          </button>
          );
        })}
        {nodeOnlyProfiles.length > 0 && <p className="mb-1 mt-3 px-3 text-xs text-muted-foreground">{t("agents.profile.nodeSettings")}</p>}
        {nodeOnlyProfiles.map((agent) => {
          const listPortraitUrl = savedPortraitUrl(agent.id, Boolean(agent.portraitUrl));
          return (
          <button
            key={agent.id}
            type="button"
            className={`mb-1 flex w-full items-center gap-2 rounded-floor px-3 py-2 text-left text-sm ${selectedNodeProfile?.id === agent.id ? "bg-accent-blue/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => selectNodeProfile(agent.id)}
          >
            {listPortraitUrl ? (
              <img src={listPortraitUrl} alt={agent.name} className="h-8 w-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground" aria-hidden="true">
                {agent.name.charAt(0)}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate font-semibold">{agent.name}</span>
              <span className="block truncate text-xs">{agent.id}</span>
            </span>
          </button>
          );
        })}
      </aside>

      <div className="flex min-h-0 flex-col p-4" data-testid="agent-profile-editor">
        {selectedNodeProfile && loadedNodeId !== selectedNodeId ? <FrameLoading label={t("agents.profile.loadingNodeAgentsEllipsis")} /> : selectedNodeProfile ? (
          <>
          {/* 노드 설정 전용 프로필은 프로필 항목을 여기서 고치지 않는다. 편집 탭은 열어 초상 칸만 보인다. */}
          <div className="mcp-tabs"><DetailTabs<"assembly" | "edit" | "mcp">
            id="agent-profile-pane"
            label={t("agents.profile.views")}
            panelId="agent-profile-pane-panel"
            tabs={[["assembly", t("agents.profile.assembly")], ["edit", t("agents.profile.edit")], ["mcp", "MCP"]]}
            value={pane}
            onChange={setPane}
          /></div>
          <div id="agent-profile-pane-panel" role="tabpanel" className="mt-3 flex min-h-0 flex-1 flex-col">
            {pane === "edit" ? (
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
                <section>
                  <PortraitField
                    name={selectedNodeProfile.name}
                    previewUrl={portraitPreviewUrl}
                    savedUrl={savedPortraitUrl(selectedNodeProfile.id, Boolean(selectedNodeProfile.portraitUrl))}
                    removePortrait={removePortrait}
                    onFile={(event) => choosePortrait(event, setPortraitFile, setRemovePortrait)}
                    onRemoveChange={(remove) => {
                      setRemovePortrait(remove);
                      if (remove) setPortraitFile(null);
                    }}
                  />
                </section>
                {error && <p role="alert" className="rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">{errorText}</p>}
                {message && <p role="status" className="rounded-floor bg-accent-blue/10 px-3 py-2 text-sm">{message}</p>}
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" disabled={saving || (!portraitFile && !removePortrait)} onClick={() => void saveNodePortrait(selectedNodeProfile.id)}>{saving ? t("agents.saving") : t("agents.portrait.save")}</Button>
                </div>
              </div>
            ) : pane === "mcp" ? !selectedNodeId ? <FrameNotice>{t("agents.assignment.noNodes")}</FrameNotice> : <AgentMcpConnectionPane key={`${selectedNodeProfile.id}:${selectedNodeId}`} agentId={selectedNodeProfile.id} nodeId={selectedNodeId} request={request} onEditProfile={onEditMcpProfile ?? (() => {})} focusOnMount={focusMcpTarget} onFocusHandled={() => setFocusMcpTarget(false)} /> : <AgentContextAssemblyView
              key={`node:${selectedNodeProfile.id}`}
              target={{ kind: "node", agentId: selectedNodeProfile.id }}
              nodeId={selectedNodeId}
              initialBackend={selectedNodeProfile.backend ?? "claude"}
              presentOnNode
              request={request}
            />}
          </div>
          </>
        ) : !draft ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t("agents.profile.empty")}</div>
        ) : (
          <>
          <div className="mcp-tabs"><DetailTabs<"assembly" | "edit" | "mcp">
            id="agent-profile-pane"
            label={t("agents.profile.views")}
            panelId="agent-profile-pane-panel"
            tabs={[["assembly", t("agents.profile.assembly")], ["edit", t("agents.profile.edit")], ["mcp", "MCP", !draft.version]]}
            value={pane}
            onChange={setPane}
          /></div>
          <div id="agent-profile-pane-panel" role="tabpanel" className="mt-3 flex min-h-0 flex-1 flex-col">
          {pane === "mcp" ? !selectedNodeId ? <FrameNotice>{t("agents.assignment.noNodes")}</FrameNotice> : <AgentMcpConnectionPane key={`${draft.agent_id}:${selectedNodeId}`} agentId={draft.agent_id} nodeId={selectedNodeId} request={request} onEditProfile={onEditMcpProfile ?? (() => {})} focusOnMount={focusMcpTarget} onFocusHandled={() => setFocusMcpTarget(false)} /> : pane === "assembly" ? !selectedNodeId ? (
            <FrameNotice>{t("agents.assignment.noNodes")}</FrameNotice>
          ) : loadedNodeId !== selectedNodeId ? (
            <FrameLoading label={t("agents.profile.loadingNodeAgents")} />
          ) : (
            <AgentContextAssemblyView
              key={`central:${draft.agent_id}`}
              target={{ kind: "central", agentId: draft.agent_id, specs: effectiveContexts }}
              nodeId={selectedNodeId}
              initialBackend={nodeAgent?.backend ?? "claude"}
              presentOnNode={Boolean(nodeAgent)}
              request={request}
            />
          ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
            <section className="grid grid-cols-2 gap-3">
              <LabeledInput
                label={t("agents.profile.agentId")}
                value={draft.agent_id}
                disabled={draft.version > 0}
                onChange={(value) => setDraft({ ...draft, agent_id: value })}
              />
              <LabeledInput label={t("agents.profile.name")} value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
              <LabeledInput
                label={t("agents.profile.defaultPreset")}
                value={draft.default_preset ?? ""}
                placeholder={t("agents.unassigned")}
                onChange={(value) => setDraft({ ...draft, default_preset: value || null })}
              />
              <PortraitField
                name={draft.name}
                previewUrl={portraitPreviewUrl}
                savedUrl={savedPortraitUrl(draft.agent_id, draft.has_portrait)}
                removePortrait={removePortrait}
                onFile={(event) => choosePortrait(event, setPortraitFile, setRemovePortrait)}
                onRemoveChange={(remove) => {
                  setRemovePortrait(remove);
                  if (remove) setPortraitFile(null);
                }}
              />
            </section>

            <section>
              <SectionHeading title={t("agents.bundle.title")} />
              <p className="mb-2 text-xs text-muted-foreground">{t("agents.bundle.editHelp")}</p>
              <div className="space-y-2">
                {draft.context_bundles.map((bundleId, index) => {
                  const bundle = bundles.find((candidate) => candidate.bundle_id === bundleId);
                  return (
                    <div key={bundleId} className="flex items-center gap-2 rounded-floor border border-border bg-muted/10 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate" title={bundle?.description} data-v3-selectable-content="true">
                        <strong>{bundleId}</strong>{bundle?.description ? ` · ${bundle.description}` : ""}
                      </span>
                      <Button type="button" size="sm" variant="ghost" aria-label={t("agents.bundle.moveUpLabel", { bundleId })} disabled={index === 0} onClick={() => setDraft(moveBundleReference(draft, index, -1))}>{t("agents.moveUp")}</Button>
                      <Button type="button" size="sm" variant="ghost" aria-label={t("agents.bundle.moveDownLabel", { bundleId })} disabled={index === draft.context_bundles.length - 1} onClick={() => setDraft(moveBundleReference(draft, index, 1))}>{t("agents.moveDown")}</Button>
                      <Button type="button" size="sm" variant="ghost" aria-label={t("agents.bundle.removeLabel", { bundleId })} onClick={() => setDraft({
                        ...draft,
                        context_bundles: draft.context_bundles.filter((_, current) => current !== index),
                      })}>{t("agents.remove")}</Button>
                    </div>
                  );
                })}
                {draft.context_bundles.length === 0 && <p className="text-xs text-muted-foreground">{t("agents.bundle.noReferences")}</p>}
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1 text-xs font-medium">
                    {t("agents.bundle.select")}
                    <select
                      aria-label={t("agents.bundle.toAdd")}
                      className={inputClassName}
                      value={selectedBundleToAdd}
                      onChange={(event) => setSelectedBundleToAdd(event.target.value)}
                    >
                      <option value="">{t("agents.bundle.selectToAdd")}</option>
                      {bundles.filter((bundle) => !draft.context_bundles.includes(bundle.bundle_id)).map((bundle) => (
                        <option key={bundle.bundle_id} value={bundle.bundle_id}>{bundle.bundle_id} · {bundle.description}</option>
                      ))}
                    </select>
                  </label>
                  <Button type="button" size="sm" variant="outline" disabled={!selectedBundleToAdd} onClick={() => {
                    setDraft({ ...draft, context_bundles: [...draft.context_bundles, selectedBundleToAdd] });
                    setSelectedBundleToAdd("");
                  }}>{t("agents.bundle.add")}</Button>
                </div>
              </div>
            </section>

            <section>
              <SectionHeading
                title={t("agents.context.atom")}
                actionLabel={t("agents.context.addSource")}
                onAction={() => setDraft({ ...draft, atom_contexts: [...draft.atom_contexts, { node_id: "", mode: "full" }] })}
              />
              <div className="space-y-3">
                {draft.atom_contexts.map((context, index) => (
                  <AgentAtomContextFields
                    key={index}
                    context={context}
                    index={index}
                    onChange={(next) => updateContext(draft, setDraft, index, next)}
                    onRemove={() => setDraft({
                      ...draft,
                      atom_contexts: draft.atom_contexts.filter((_, current) => current !== index),
                    })}
                  />
                ))}
                {draft.atom_contexts.length === 0 && <p className="text-xs text-muted-foreground">{t("agents.context.noSources")}</p>}
              </div>
            </section>

            <section>
              <SectionHeading
                title={t("agents.profile.aliases")}
                actionLabel={t("agents.profile.addAlias")}
                onAction={() => setDraft({ ...draft, aliases: [...draft.aliases, { id: "", default_preset: "" }] })}
              />
              <div className="space-y-2">
                {draft.aliases.map((alias, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                    <LabeledInput label={t("agents.profile.aliasId")} value={alias.id} onChange={(value) => updateAlias(draft, setDraft, index, { ...alias, id: value })} />
                    <LabeledInput label={t("agents.profile.aliasPreset")} value={alias.default_preset} placeholder={t("agents.profile.inheritPreset")} onChange={(value) => updateAlias(draft, setDraft, index, { ...alias, default_preset: value })} />
                    <Button type="button" size="sm" variant="ghost" className="mt-5" onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, current) => current !== index) })}>{t("agents.delete")}</Button>
                  </div>
                ))}
              </div>
            </section>

            {error && <p role="alert" className="rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">{errorText}</p>}
            {message && <p role="status" className="rounded-floor bg-accent-blue/10 px-3 py-2 text-sm">{message}</p>}
            <div className="flex justify-end gap-2">
              {error instanceof VersionConflictError && (
                <Button type="button" size="sm" variant="outline" onClick={() => void loadProfiles(draft.agent_id)}>{t("agents.reloadLatest")}</Button>
              )}
              <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{saving ? t("agents.saving") : t("agents.profile.save")}</Button>
            </div>
          </div>
          )}
          </div>
          </>
        )}
      </div>
    </div>
      )}
    </div>
  );
}

function PortraitField({ name, previewUrl, savedUrl, removePortrait, onFile, onRemoveChange }: {
  name: string;
  previewUrl: string | null;
  savedUrl: string;
  removePortrait: boolean;
  onFile(event: ChangeEvent<HTMLInputElement>): void;
  onRemoveChange(remove: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="mb-1 block text-xs font-medium">{t("agents.portrait.label")}</label>
      <div className="flex items-start gap-3">
        {!removePortrait && (previewUrl || savedUrl) ? (
          <img
            src={previewUrl ?? savedUrl}
            alt={name}
            className="h-24 w-24 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span data-testid="profile-portrait-placeholder" className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-muted text-2xl font-medium text-muted-foreground" aria-hidden="true">
            {name.charAt(0) || "?"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <input
            aria-label={t("agents.portrait.label")}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="block w-full text-xs"
            onChange={onFile}
          />
          {savedUrl && (
            <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={removePortrait}
                onChange={(event) => onRemoveChange(event.target.checked)}
              />
              {t("agents.portrait.remove")}
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, actionLabel, onAction }: { title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-sm font-semibold">{title}</h3>
      {actionLabel && <Button type="button" size="sm" variant="outline" onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}

function profileDraft(profile: AgentProfile): ProfileDraft {
  return {
    ...structuredClone(profile),
    aliases: profile.aliases.map((alias) => typeof alias === "string"
      ? { id: alias, default_preset: "" }
      : { id: alias.id, default_preset: alias.default_preset ?? "" }),
  };
}

function updateContext(draft: ProfileDraft, setDraft: (draft: ProfileDraft) => void, index: number, context: AgentAtomContext) {
  setDraft({ ...draft, atom_contexts: draft.atom_contexts.map((current, currentIndex) => currentIndex === index ? context : current) });
}

function updateAlias(draft: ProfileDraft, setDraft: (draft: ProfileDraft) => void, index: number, alias: AliasDraft) {
  setDraft({ ...draft, aliases: draft.aliases.map((current, currentIndex) => currentIndex === index ? alias : current) });
}

function moveBundleReference(draft: ProfileDraft, index: number, offset: -1 | 1): ProfileDraft {
  const contextBundles = [...draft.context_bundles];
  [contextBundles[index], contextBundles[index + offset]] = [contextBundles[index + offset], contextBundles[index]];
  return { ...draft, context_bundles: contextBundles };
}

async function fetchBundles(request: typeof fetch, t: Translate): Promise<ContextBundle[]> {
  const response = await request("/api/context-bundles", { credentials: "same-origin" });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(responseMessage(body, t("agents.bundle.loadError")));
  return Array.isArray(body.bundles) ? body.bundles as ContextBundle[] : [];
}

async function putProfile(draft: ProfileDraft, request: typeof fetch, t: Translate): Promise<AgentProfile> {
  const response = await request(`/api/agent-profiles/${encodeURIComponent(draft.agent_id.trim())}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: draft.name.trim(),
      atom_contexts: draft.atom_contexts,
      context_bundles: draft.context_bundles,
      default_preset: draft.default_preset || null,
      aliases: draft.aliases.filter((alias) => alias.id.trim()).map((alias) => alias.default_preset
        ? { id: alias.id.trim(), default_preset: alias.default_preset }
        : alias.id.trim()),
      expected_version: draft.version || null,
    }),
  });
  return profileResponse(response, t("agents.profile.saveError"));
}

const PORTRAIT_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

interface PortraitItem {
  mime: string;
  byte_size: number;
  sha256: string;
}

/** 중앙 초상 저장소에 올린다. 중앙 프로필 행이 없는 에이전트도 같은 길이다. */
async function putPortrait(agentId: string, file: File, request: typeof fetch, t: Translate): Promise<PortraitItem> {
  if (!PORTRAIT_MIMES.includes(file.type)) throw new Error(t("agents.portrait.invalidFormat"));
  const response = await request(`/api/agent-portraits/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data_base64: await fileBase64(file, t), mime: file.type }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(responseMessage(body, t("agents.portrait.saveError")));
  return body as unknown as PortraitItem;
}

async function deletePortrait(agentId: string, request: typeof fetch, t: Translate): Promise<void> {
  const response = await request(`/api/agent-portraits/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(responseMessage(await responseJson(response), t("agents.portrait.deleteError")));
}

function withPortrait(profile: AgentProfile, item: PortraitItem | null): AgentProfile {
  return {
    ...profile,
    has_portrait: item !== null,
    portrait: item === null ? null : { mime: item.mime, size: item.byte_size, sha256: item.sha256 },
  };
}

async function profileResponse(response: Response, fallback: string): Promise<AgentProfile> {
  const body = await responseJson(response);
  if (response.status === 409 || body.code === "agent_profile_version_conflict") throw new VersionConflictError();
  if (!response.ok) throw new Error(responseMessage(body, fallback));
  return body as AgentProfile;
}

class VersionConflictError extends Error {}

function responseMessage(body: Record<string, any>, fallback: string): string {
  return typeof body.detail === "string"
    ? body.detail
    : typeof body.error?.message === "string"
      ? body.error.message
      : fallback;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json() as Record<string, any>;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown, t: Translate): string {
  return error instanceof Error ? error.message : t("agents.requestError");
}

function upsertProfile(profiles: AgentProfile[], profile: AgentProfile): AgentProfile[] {
  const without = profiles.filter((current) => current.agent_id !== profile.agent_id);
  return [...without, profile].sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function choosePortrait(
  event: ChangeEvent<HTMLInputElement>,
  setFile: (file: File | null) => void,
  setRemove: (remove: boolean) => void,
) {
  setFile(event.target.files?.[0] ?? null);
  setRemove(false);
}

function fileBase64(file: File, t: Translate): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("agents.portrait.readError")));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
