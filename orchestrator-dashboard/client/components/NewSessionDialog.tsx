/**
 * NewSessionDialog -- 새 세션 생성 다이얼로그 (오케스트레이터용)
 *
 * soul-ui의 공유 NewSessionDialog를 사용하되,
 * nodeSelector 슬롯으로 노드 선택 드롭다운을 주입한다.
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

interface NewSessionDialogProps {
  /** 특정 노드에서 열면 해당 노드로 고정. undefined면 드롭다운 표시. */
  nodeId?: string;
  nodeColor?: string;
}

export function NewSessionDialog({ nodeId, nodeColor }: NewSessionDialogProps) {
  const nodes = useOrchestratorStore((s) => s.nodes);

  const [open, setOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(nodeId ?? "");

  const aliveNodes = Array.from(nodes.values()).filter(
    (n) => n.status === "connected",
  );

  const handleSubmit = useCallback(
    async (prompt: string) => {
      const targetNode = nodeId ?? selectedNodeId;
      if (!targetNode) throw new Error("Please select a node");

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, nodeId: targetNode }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const { sessionId } = await res.json();
      setOpen(false);
      useDashboardStore.getState().setActiveSession(sessionId);
    },
    [nodeId, selectedNodeId],
  );

  // 노드 선택 슬롯
  const nodeSelector = !nodeId ? (
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
  ) : (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Node</label>
      <div
        className="text-sm font-mono px-3 py-2 rounded-md bg-muted border border-input"
        style={
          nodeColor
            ? { borderLeftColor: nodeColor, borderLeftWidth: 3 }
            : undefined
        }
      >
        {nodeId}
      </div>
    </div>
  );

  return (
    <>
      <button
        className="text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground/70 py-1 transition-colors"
        style={
          nodeColor
            ? {
                color: `color-mix(in srgb, ${nodeColor} 50%, transparent)`,
              }
            : undefined
        }
        onClick={() => setOpen(true)}
      >
        + New Session
      </button>
      <BaseNewSessionDialog
        open={open}
        onOpenChange={setOpen}
        onSubmit={handleSubmit}
        nodeSelector={nodeSelector}
        submitDisabled={!nodeId && !selectedNodeId}
      />
    </>
  );
}
