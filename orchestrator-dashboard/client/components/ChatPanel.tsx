/**
 * ChatPanel — 우측 채팅 패널.
 *
 * 세션이 선택되면 세션 컨텍스트 + 이벤트 스트림 표시.
 * 노드 dead 시 인터벤션/응답 버튼이 soul-ui ChatView 내부적으로 비활성화.
 */

import { useMemo } from "react";
import { Badge, ChatView } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { nodeColor } from "./NodeHeader";
import { useSessionStream } from "../hooks/useSessionStream";

export function ChatPanel() {
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedSessionId = useOrchestratorStore((s) => s.selectedSessionId);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const sessions = useOrchestratorStore((s) => s.sessions);

  const selectedNode = selectedNodeId ? nodes.get(selectedNodeId) : null;
  const isDead = selectedNode?.status === "disconnected";

  const colorIndex = useMemo(() => {
    if (!selectedNodeId) return 0;
    return Array.from(nodes.keys()).indexOf(selectedNodeId);
  }, [selectedNodeId, nodes]);

  const selectedSession = useMemo(() => {
    if (!selectedNodeId || !selectedSessionId) return null;
    const nodeSessions = sessions.get(selectedNodeId);
    return nodeSessions?.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [selectedNodeId, selectedSessionId, sessions]);

  const { status: streamStatus } = useSessionStream();

  if (!selectedNodeId || !selectedSessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground/30">
        <div className="text-2xl opacity-30">&#9678;</div>
        <div className="text-[13px] text-center leading-relaxed text-muted-foreground/50">
          좌측 노드 패널에서 세션을 선택하세요
          <br />
          또는 노드에서 새 세션을 생성하세요
        </div>
      </div>
    );
  }

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
          {isDead && (
            <Badge variant="warning" size="sm">
              node dead
            </Badge>
          )}
        </div>
      </div>

      {/* Session context card */}
      {selectedNode && selectedSession && (
        <div
          className="mx-3.5 mt-2 px-3 py-2 bg-muted border border-input rounded-lg border-l-[3px] shrink-0"
          style={{ borderLeftColor: color }}
        >
          <div className="text-[11px] font-mono opacity-70" style={{ color }}>
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
            {isDead && (
              <Badge variant="outline" size="sm">
                재개 불가
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* ChatView — soul-ui (ChatInput 내장, 노드 dead 시 soul-ui 내부적으로 입력 비활성화) */}
      <ChatView />
    </div>
  );
}
