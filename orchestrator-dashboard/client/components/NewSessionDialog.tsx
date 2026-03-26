/**
 * NewSessionDialog -- 새 세션 생성 다이얼로그 (오케스트레이터용)
 *
 * soul-ui의 공유 NewSessionDialog를 사용하되,
 * folderSelector 슬롯으로 폴더 선택 드롭다운을,
 * nodeSelector 슬롯으로 노드 선택 드롭다운을 주입한다.
 *
 * App.tsx modals 슬롯에서만 사용된다.
 * nodeId/nodeColor prop 없음 — isNewSessionModalOpen 스토어 단일 경로.
 *
 * 진입 경로(newSessionSource)에 따라 초기 폴더를 다르게 설정한다:
 * - 'feed' 진입: '클로드 코드 세션' 폴더 사전 선택
 * - 'folder' 진입: 현재 선택된 폴더 사전 선택
 */

import { useState, useCallback, useEffect } from "react";
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
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);

  const aliveNodes = Array.from(nodes.values()).filter(
    (n) => n.status === "connected",
  );

  // '클로드 코드 세션' 폴더 ID
  const claudeFolder = catalog?.folders.find((f) => f.name === '클로드 코드 세션');

  // 모달이 열릴 때 진입 경로에 따라 초기 폴더 설정
  useEffect(() => {
    if (isModalOpen) {
      if (newSessionSource === 'feed') {
        setSelectedModalFolderId(claudeFolder?.id ?? null);
      } else {
        setSelectedModalFolderId(selectedFolderId);
      }
    }
  }, [isModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const { agentSessionId } = await res.json();
      const { addOptimisticSession } = useDashboardStore.getState();
      addOptimisticSession(
        agentSessionId,
        prompt,
        selectedModalFolderId ?? null,
        selectedNodeId,
      );
      closeNewSessionModal();
      setSelectedNodeId("");
      setSelectedModalFolderId(null);
    },
    [selectedNodeId, selectedModalFolderId, closeNewSessionModal],
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

  return (
    <BaseNewSessionDialog
      open={isModalOpen}
      onOpenChange={(v) => {
        if (!v) {
          closeNewSessionModal();
          setSelectedNodeId(""); // 닫힐 때 선택 초기화
          setSelectedModalFolderId(null);
        }
      }}
      onSubmit={handleSubmit}
      folderSelector={folderSelector}
      nodeSelector={nodeSelector}
      submitDisabled={!selectedNodeId}
    />
  );
}
