/**
 * NewSessionDialog -- 새 세션 생성 다이얼로그 (오케스트레이터용)
 *
 * soul-ui의 공유 NewSessionDialog를 사용하되,
 * nodeSelector 슬롯으로 노드 선택 드롭다운을 주입한다.
 *
 * App.tsx modals 슬롯에서만 사용된다.
 * nodeId/nodeColor prop 없음 — isNewSessionModalOpen 스토어 단일 경로.
 */

import { useState, useCallback } from "react";
import {
  NewSessionDialog as BaseNewSessionDialog,
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

export function NewSessionDialog() {
  const isModalOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeNewSessionModal = useDashboardStore((s) => s.closeNewSessionModal);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const [selectedNodeId, setSelectedNodeId] = useState("");

  const aliveNodes = Array.from(nodes.values()).filter(
    (n) => n.status === "connected",
  );

  const handleSubmit = useCallback(
    async (prompt: string) => {
      if (!selectedNodeId) throw new Error("Please select a node");

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, nodeId: selectedNodeId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const { sessionId } = await res.json();
      closeNewSessionModal();
      setSelectedNodeId(""); // 선택 초기화
      useDashboardStore.getState().setActiveSession(sessionId);
    },
    [selectedNodeId, closeNewSessionModal],
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

  return (
    <BaseNewSessionDialog
      open={isModalOpen}
      onOpenChange={(v) => {
        if (!v) {
          closeNewSessionModal();
          setSelectedNodeId(""); // 닫힐 때 선택 초기화
        }
      }}
      onSubmit={handleSubmit}
      nodeSelector={nodeSelector}
      submitDisabled={!selectedNodeId}
    />
  );
}
