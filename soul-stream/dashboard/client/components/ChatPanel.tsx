/**
 * ChatPanel — 우측 채팅 패널.
 *
 * 세션이 선택되면 세션 컨텍스트 + 이벤트 스트림 표시.
 * 세션이 없으면 빈 상태 안내.
 */

import { useMemo } from "react";
import { Badge, cn } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { nodeColor } from "./NodeHeader";

export function ChatPanel() {
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedSessionId = useOrchestratorStore((s) => s.selectedSessionId);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const sessions = useOrchestratorStore((s) => s.sessions);

  const selectedNode = selectedNodeId ? nodes.get(selectedNodeId) : null;

  // 노드 색상 인덱스 — 한 번만 계산
  const colorIndex = useMemo(() => {
    if (!selectedNodeId) return 0;
    return Array.from(nodes.keys()).indexOf(selectedNodeId);
  }, [selectedNodeId, nodes]);

  // 선택된 세션 정보
  const selectedSession = useMemo(() => {
    if (!selectedNodeId || !selectedSessionId) return null;
    const nodeSessions = sessions.get(selectedNodeId);
    return nodeSessions?.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [selectedNodeId, selectedSessionId, sessions]);

  // 빈 상태
  if (!selectedNodeId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/30">
        <div className="text-2xl opacity-30">&#9678;</div>
        <div className="text-[13px] text-center leading-relaxed text-muted-foreground/50">
          좌측 노드에서 세션을 선택하거나
          <br />
          노드 헤더를 클릭하여 노드 정보를 확인하세요
        </div>
        <div className="text-[11px] text-muted-foreground/30 font-mono">
          활성 세션은 실시간으로 업데이트됩니다
        </div>
      </div>
    );
  }

  // 노드만 선택 (세션은 미선택)
  if (!selectedSessionId && selectedNode) {
    const nodeSessions = sessions.get(selectedNodeId) ?? [];
    const running = nodeSessions.filter((s) => s.status === "running").length;
    const completed = nodeSessions.filter(
      (s) => s.status === "completed",
    ).length;

    return (
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="text-sm font-medium text-foreground">
            {selectedNode.nodeId}
          </div>
          <div className="text-[11px] text-muted-foreground/50 mt-0.5 font-mono">
            {selectedNode.host}:{selectedNode.port}
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <div className="text-xl opacity-50">&#9678;</div>
          <div className="text-[13px] text-center text-muted-foreground">
            <strong>{selectedNode.nodeId}</strong>
            <br />
            {running} running &middot; {completed} completed &middot;{" "}
            {nodeSessions.length} total
          </div>
          <div className="text-xs text-muted-foreground/50 font-mono">
            Status: {selectedNode.status}
          </div>
        </div>
      </div>
    );
  }

  // 세션 선택됨 — 세션 컨텍스트 + 이벤트 뷰어
  const color = nodeColor(colorIndex);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground truncate max-w-60">
              {selectedSessionId}
            </div>
            <div className="text-[11px] text-muted-foreground/50 mt-0.5 font-mono">
              {selectedNode?.nodeId}
            </div>
          </div>
        </div>
      </div>

      {/* Session context card */}
      {selectedNode && selectedSession && (
        <div
          className="mx-3.5 mt-2 px-3 py-2 bg-muted border border-input rounded-lg border-l-[3px] shrink-0"
          style={{ borderLeftColor: color }}
        >
          <div
            className="text-[11px] font-mono opacity-70"
            style={{ color: color }}
          >
            {selectedNode.nodeId} &middot; {selectedNode.host}
          </div>
          <div className="text-[13px] font-medium text-foreground mt-0.5">
            {selectedSession.sessionId}
          </div>
          <div className="flex gap-1.5 mt-1">
            <Badge
              variant={selectedSession.status === "running" ? "success" : "outline"}
              size="sm"
            >
              {selectedSession.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-[pulse_2s_infinite]" />
              )}
              {selectedSession.status}
            </Badge>
          </div>
        </div>
      )}

      {/* Session events placeholder */}
      <div className="flex-1 overflow-y-auto px-3.5 py-3 flex flex-col gap-2.5">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground/30 font-mono text-center">
            세션 이벤트 스트리밍은 소울 서버 연결 후 활성화됩니다
          </div>
        </div>
      </div>

      {/* Input — 소울 서버 연결 전에는 비활성화 */}
      <div className="px-3.5 py-2.5 border-t border-border shrink-0 flex gap-2 items-end">
        <textarea
          className="flex-1 bg-muted border border-input rounded-[10px] px-3 py-2 text-sm text-foreground resize-none outline-none leading-snug max-h-[100px] transition-colors placeholder:text-muted-foreground/30 focus:border-accent-blue/30 focus:shadow-[0_0_0_3px_rgba(59,130,246,0.08)] disabled:opacity-50"
          rows={1}
          placeholder="메시지 입력..."
          disabled
        />
        <button
          className="w-8 h-8 rounded-lg border-none bg-accent-blue/10 text-accent-blue text-sm cursor-pointer transition-colors flex items-center justify-center shrink-0 hover:bg-accent-blue/20 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled
        >
          &#8593;
        </button>
      </div>
    </div>
  );
}
