import { useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "@seosoyoung/soul-ui";

import { useOrchestratorStore } from "../store/orchestrator-store";

export function AgentNodeAssignmentFields({
  agentId,
  nodeId,
  preferredAgentId,
  preferredNodeId,
  fallbackToAvailable = false,
  disabled = false,
  onAgentIdChange,
  onNodeIdChange,
  onAgentInfoChange,
  onError,
}: {
  agentId: string;
  nodeId: string;
  preferredAgentId?: string | null;
  preferredNodeId?: string | null;
  fallbackToAvailable?: boolean;
  disabled?: boolean;
  onAgentIdChange(value: string): void;
  onNodeIdChange(value: string): void;
  onAgentInfoChange?(value: AgentInfo | null): void;
  onError?(message: string): void;
}) {
  const nodes = useOrchestratorStore((state) => state.nodes);
  const aliveNodes = useMemo(
    () => [...nodes.values()].filter((node) => node.status === "connected"),
    [nodes],
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    if (nodeId && (aliveNodes.some((node) => node.nodeId === nodeId) || !fallbackToAvailable)) return;
    const preferred = preferredNodeId
      ? aliveNodes.find((node) => node.nodeId === preferredNodeId)
      : null;
    onNodeIdChange(preferred?.nodeId ?? (fallbackToAvailable ? aliveNodes[0]?.nodeId ?? "" : ""));
  }, [aliveNodes, fallbackToAvailable, nodeId, onNodeIdChange, preferredNodeId]);

  useEffect(() => {
    setAgents([]);
    onAgentInfoChange?.(null);
    if (!nodeId) return;
    let active = true;
    void fetch(`/api/nodes/${encodeURIComponent(nodeId)}/agents`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`에이전트 목록을 불러오지 못했습니다 (${response.status})`);
      return await response.json() as { agents?: AgentInfo[] };
    }).then((payload) => {
      if (!active) return;
      const next = payload.agents ?? [];
      setAgents(next);
      const current = next.find((agent) => agent.id === agentId);
      const preferred = next.find((agent) => agent.id === preferredAgentId);
      const selected = current ?? preferred ?? (fallbackToAvailable ? next[0] : null) ?? null;
      if (selected?.id !== agentId && (selected || fallbackToAvailable)) onAgentIdChange(selected?.id ?? "");
      onAgentInfoChange?.(selected);
    }).catch((caught: unknown) => {
      if (active) onError?.(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [agentId, fallbackToAvailable, nodeId, onAgentIdChange, onAgentInfoChange, onError, preferredAgentId]);

  const nodeOptions = nodeId && !aliveNodes.some((node) => node.nodeId === nodeId)
    ? [{ nodeId }, ...aliveNodes]
    : aliveNodes;
  const agentOptions = agentId && !agents.some((agent) => agent.id === agentId)
    ? [{ id: agentId, name: agentId } as AgentInfo, ...agents]
    : agents;

  return (
    <div className="v3-succession-assignment">
      <label>
        실행 에이전트
        <select
          value={agentId}
          aria-label="기본 실행 에이전트"
          disabled={disabled || !nodeId}
          onChange={(event) => {
            onAgentIdChange(event.target.value);
            onAgentInfoChange?.(agentOptions.find((agent) => agent.id === event.target.value) ?? null);
          }}
        >
          <option value="">미지정</option>
          {agentOptions.map((agent) => <option key={agent.id} value={agent.id}>{agent.name ?? agent.id}</option>)}
        </select>
      </label>
      <label>
        실행 노드
        <select value={nodeId} aria-label="기본 실행 노드" disabled={disabled} onChange={(event) => onNodeIdChange(event.target.value)}>
          <option value="">미지정</option>
          {nodeOptions.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId}</option>)}
        </select>
      </label>
    </div>
  );
}
