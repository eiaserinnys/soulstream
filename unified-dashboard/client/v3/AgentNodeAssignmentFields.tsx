import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "@seosoyoung/soul-ui";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { AgentSelectionField } from "./AgentSelectionField";
import { CatalogSelectionField } from "../components/CatalogSelectionField";
import { NodeModelPresetSelect } from "../components/NodeModelPresetSelect";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { useOrchestratorStore } from "../store/orchestrator-store";

export interface AssignmentData { nodes: Array<{nodeId: string; status: string}>; agents: AgentInfo[]; modelPresetCatalog: NodeModelPresetCatalog }

export function AgentNodeAssignmentFields({
  data,
  agentId,
  nodeId,
  modelPreset,
  preferredAgentId,
  preferredNodeId,
  fallbackToAvailable = false,
  disabled = false,
  onAgentIdChange,
  onNodeIdChange,
  onModelPresetChange,
  modelPresetCatalog: suppliedModelPresetCatalog,
  onAgentInfoChange,
  onModelPresetInfoChange,
  onModelPresetValidityChange,
  onError,
}: {
  data?: AssignmentData;
  agentId: string;
  nodeId: string;
  modelPreset: string;
  preferredAgentId?: string | null;
  preferredNodeId?: string | null;
  fallbackToAvailable?: boolean;
  disabled?: boolean;
  onAgentIdChange(value: string): void;
  onNodeIdChange(value: string): void;
  onModelPresetChange(value: string): void;
  modelPresetCatalog?: NodeModelPresetCatalog;
  onAgentInfoChange?(value: AgentInfo | null): void;
  onModelPresetInfoChange?(value: ModelPresetAvailability | null): void;
  onModelPresetValidityChange?(valid: boolean): void;
  onError?(message: string): void;
}) {
  const { t, i18n } = useTranslation();
  const modelPresetCatalog = data?.modelPresetCatalog ?? suppliedModelPresetCatalog;
  const nodes = useOrchestratorStore((state) => state.nodes);
  const aliveNodes = useMemo(
    () => (data?.nodes ?? [...nodes.values()]).filter((node) => node.status === "connected"),
    [nodes, data],
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    // A caller that deliberately manages the selection must never have an
    // older empty render write back over a persisted node choice.
    if (!fallbackToAvailable) return;
    if (nodeId && aliveNodes.some((node) => node.nodeId === nodeId)) return;
    const preferred = preferredNodeId
      ? aliveNodes.find((node) => node.nodeId === preferredNodeId)
      : null;
    const nextNodeId = preferred?.nodeId ?? aliveNodes[0]?.nodeId ?? "";
    if (nextNodeId !== nodeId) onNodeIdChange(nextNodeId);
  }, [aliveNodes, fallbackToAvailable, nodeId, onNodeIdChange, preferredNodeId]);

  useEffect(() => {
    if (!nodeId) {
      setAgents([]);
      setLoadedNodeId(null);
      return;
    }
    if (data) { setAgents(data.agents); setLoadedNodeId(nodeId); return; }
    let active = true;
    void fetch(`/api/nodes/${encodeURIComponent(nodeId)}/agents`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) throw new Error(i18n.t("agents.assignment.loadError", { status: response.status }));
      return await response.json() as { agents?: AgentInfo[] };
    }).then((payload) => {
      if (!active) return;
      const next = payload.agents ?? [];
      setAgents(next);
      setLoadedNodeId(nodeId);
    }).catch((caught: unknown) => {
      if (active) onErrorRef.current?.(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [nodeId, data, i18n]);

  useEffect(() => {
    if (!nodeId) {
      onAgentInfoChange?.(null);
      return;
    }
    if (loadedNodeId !== nodeId) return;
    const current = agents.find((agent) => agent.id === agentId);
    const preferred = agents.find((agent) => agent.id === preferredAgentId);
    const selected = current ?? preferred ?? (fallbackToAvailable ? agents[0] : null) ?? null;
    if (selected?.id !== agentId && (selected || fallbackToAvailable)) {
      onAgentIdChange(selected?.id ?? "");
    }
    onAgentInfoChange?.(selected);
  }, [agentId, agents, fallbackToAvailable, loadedNodeId, nodeId, onAgentIdChange, onAgentInfoChange, preferredAgentId]);

  const nodeOptions = nodeId && !aliveNodes.some((node) => node.nodeId === nodeId)
    ? [{ nodeId }, ...aliveNodes]
    : aliveNodes;
  const agentOptions = agentId && !agents.some((agent) => agent.id === agentId)
    ? [{ id: agentId, name: agentId } as AgentInfo, ...agents]
    : agents;

  const agentField = <AgentSelectionField agents={agentOptions} value={agentId}
    presentation="session" disabled={disabled || !nodeId} onChange={value => {
      onAgentIdChange(value);
      onAgentInfoChange?.(agentOptions.find(agent => agent.id === value) ?? null);
    }} />;
  const nodeField = (
    <CatalogSelectionField className="v3-assignment-field" value={nodeId} disabled={disabled}
      label={t("agents.assignment.node")}
      ariaLabel={t("agents.assignment.chooseNode")}
      selectedLabel={nodeId || t("agents.unassigned")}
      options={[{ value: "", label: t("agents.unassigned") }, ...nodeOptions.map(node => ({ value: node.nodeId, label: node.nodeId }))]}
      onValueChange={onNodeIdChange} />
  );
  const modelField = (
    <NodeModelPresetSelect
      className="v3-model-preset-field"
      nodeId={nodeId}
      value={modelPreset}
      label={t("agents.assignment.model")}
      disabled={disabled}
      triggerClassName="v3-model-preset-trigger"
      modelPresetCatalog={modelPresetCatalog}
      agentBackend={agents.find((agent) => agent.id === agentId)?.backend}
      onValueChange={onModelPresetChange}
      onPresetChange={onModelPresetInfoChange}
      onValidityChange={onModelPresetValidityChange}
      onError={onError}
    />
  );

  return (
    <div
      className="v3-succession-assignment"
    >
      {nodeField}{agentField}{modelField}
    </div>
  );
}
