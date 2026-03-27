/**
 * OrchestratorNewSessionModal - orchestrator 모드 새 세션 생성 모달 (unified-dashboard)
 *
 * orchestrator-dashboard의 NewSessionDialog.tsx에서 포팅.
 * soul-ui의 NewSessionDialog 위에 노드 선택 UI를 추가한다.
 * Phase 4의 NewSessionModal(single-node 용)과 달리 노드 선택이 포함된다.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  NewSessionDialog as BaseNewSessionDialog,
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import type { AgentInfo } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

export function OrchestratorNewSessionModal() {
  const isModalOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeNewSessionModal = useDashboardStore((s) => s.closeNewSessionModal);
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  const aliveNodes = Array.from(nodes.values()).filter(
    (n) => n.status === "connected",
  );

  // '클로드 코드 세션' 폴더 ID
  const claudeFolder = catalog?.folders.find((f) => f.name === '클로드 코드 세션');

  // 폴더 초기화 1회 제한 — catalog 갱신 시 사용자 선택을 덮어쓰지 않도록
  const folderInitialized = useRef(false);

  // 모달이 열릴 때 진입 경로에 따라 초기 폴더 설정
  useEffect(() => {
    if (!isModalOpen) {
      folderInitialized.current = false;
      return;
    }
    if (folderInitialized.current || !catalog) return;

    folderInitialized.current = true;
    if (newSessionSource === 'feed') {
      setSelectedModalFolderId(claudeFolder?.id ?? null);
    } else {
      setSelectedModalFolderId(selectedFolderId);
    }
  }, [isModalOpen, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  // nodeId 변경 시 에이전트 목록 조회
  useEffect(() => {
    setSelectedAgentId("");
    setAgents([]);
    if (!selectedNodeId) return;

    fetch(`/api/nodes/${encodeURIComponent(selectedNodeId)}/agents`)
      .then((res) => res.json())
      .then((data: { agents: AgentInfo[] }) => {
        setAgents(data.agents ?? []);
      })
      .catch(() => {
        // 에이전트 목록 조회 실패 시 graceful degradation
        setAgents([]);
      });
  }, [selectedNodeId]);

  const handleSubmit = useCallback(
    async (prompt: string) => {
      if (!selectedNodeId) throw new Error("Please select a node");

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          nodeId: selectedNodeId,
          ...(selectedModalFolderId ? { folderId: selectedModalFolderId } : {}),
          ...(selectedAgentId ? { profile: selectedAgentId } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const { agentSessionId } = await res.json();
      const { addOptimisticSession } = useDashboardStore.getState();
      const selectedAgent = agents.find((a) => a.id === selectedAgentId);
      addOptimisticSession(
        agentSessionId,
        prompt,
        selectedModalFolderId ?? null,
        selectedNodeId,
        selectedAgentId || null,
        selectedAgent?.name ?? null,
        selectedAgent?.portraitUrl ?? null,
      );
      closeNewSessionModal();
      setSelectedNodeId("");
      setSelectedModalFolderId(null);
      setSelectedAgentId("");
    },
    [selectedNodeId, selectedModalFolderId, selectedAgentId, agents, closeNewSessionModal],
  );

  const folderSelector = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Folder</label>
      <Select
        value={selectedModalFolderId ?? ''}
        onValueChange={(v) => setSelectedModalFolderId(v || null)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a folder..." />
        </SelectTrigger>
        <SelectPopup>
          {catalog?.folders.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );

  const nodeSelector = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Node</label>
      <Select value={selectedNodeId} onValueChange={setSelectedNodeId}>
        <SelectTrigger>
          <SelectValue placeholder="Select a node..." />
        </SelectTrigger>
        <SelectPopup>
          {aliveNodes.map((n) => (
            <SelectItem key={n.nodeId} value={n.nodeId}>
              {n.nodeId}
              <span className="ml-2 text-[10px] font-mono text-muted-foreground/50">
                {n.host}:{n.port}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );

  const agentSelector = agents.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Agent</label>
      <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
        <SelectTrigger>
          <SelectValue placeholder="Select an agent..." />
        </SelectTrigger>
        <SelectPopup>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <div className="flex items-center gap-2">
                {a.portraitUrl && (
                  <img src={a.portraitUrl} alt={a.name} className="w-5 h-5 rounded shrink-0 object-cover" />
                )}
                {a.name}
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  ) : undefined;

  return (
    <BaseNewSessionDialog
      open={isModalOpen}
      onOpenChange={(v) => {
        if (!v) {
          closeNewSessionModal();
          setSelectedNodeId("");
          setSelectedModalFolderId(null);
          setSelectedAgentId("");
        }
      }}
      onSubmit={handleSubmit}
      folderSelector={folderSelector}
      nodeSelector={nodeSelector}
      agentSelector={agentSelector}
      submitDisabled={!selectedNodeId}
    />
  );
}
