/**
 * NodePanel — 좌측 하단 30%에 위치하는 노드 목록 패널.
 *
 * 노드 목록 + 각 노드의 세션 목록을 표시한다.
 * 노드 dead 시 세션 행을 비활성화하여 선택을 막는다.
 */

import { useMemo } from "react";
import { cn, Badge } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { nodeColor } from "./NodeHeader";
import { NewSessionDialog } from "./NewSessionDialog";

export function NodePanel() {
  const nodes = useOrchestratorStore((s) => s.nodes);
  const sessions = useOrchestratorStore((s) => s.sessions);
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedSessionId = useOrchestratorStore((s) => s.selectedSessionId);
  const selectNode = useOrchestratorStore((s) => s.selectNode);
  const selectSession = useOrchestratorStore((s) => s.selectSession);

  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);

  if (nodeList.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/40 text-xs">
        노드 없음
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {nodeList.map((node, index) => {
        const color = nodeColor(index);
        const nodeSessions = sessions.get(node.nodeId) ?? [];
        const isNodeSelected = selectedNodeId === node.nodeId;
        const isDead = node.status === "disconnected";

        return (
          <div key={node.nodeId} className="border-b border-border">
            {/* 노드 헤더 행 */}
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-2 cursor-pointer select-none transition-colors",
                isNodeSelected && !selectedSessionId
                  ? "bg-accent-blue/[0.06]"
                  : "hover:bg-muted",
              )}
              onClick={() => selectNode(isNodeSelected && !selectedSessionId ? null : node.nodeId)}
            >
              <div
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold font-mono shrink-0"
                style={{
                  background: `color-mix(in srgb, ${color} 12%, transparent)`,
                  color: color,
                  border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
                }}
              >
                {node.nodeId[0]?.toUpperCase()}
              </div>
              <span className="text-xs font-medium text-foreground truncate flex-1">
                {node.nodeId}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[10px] font-mono text-muted-foreground/50">
                  {nodeSessions.length}
                </span>
                <div
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    isDead ? "bg-muted-foreground/30" : "bg-success",
                  )}
                />
              </div>
            </div>

            {/* 세션 목록 */}
            {nodeSessions.length > 0 && (
              <div className="pl-8">
                {nodeSessions.map((session) => {
                  const isSelected =
                    selectedSessionId === session.sessionId &&
                    selectedNodeId === node.nodeId;
                  const isRunning = session.status === "running";

                  return (
                    <div
                      key={session.sessionId}
                      className={cn(
                        "flex items-center gap-2 px-3 py-1.5 border-b border-border/40 transition-colors",
                        isDead
                          ? "opacity-40 cursor-not-allowed"
                          : "cursor-pointer hover:bg-muted",
                        isSelected && !isDead && "bg-accent-blue/[0.08]",
                      )}
                      onClick={() => {
                        if (!isDead) {
                          selectSession(node.nodeId, session.sessionId);
                        }
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-mono text-muted-foreground/70 truncate">
                          {session.sessionId.slice(0, 8)}…
                        </div>
                        {session.prompt && (
                          <div className="text-[10px] text-muted-foreground/50 truncate mt-px">
                            {session.prompt.slice(0, 40)}
                          </div>
                        )}
                      </div>
                      <Badge
                        variant={isRunning ? "success" : "outline"}
                        size="sm"
                        className="shrink-0"
                      >
                        {isRunning && (
                          <span className="w-1 h-1 rounded-full bg-success animate-[pulse_2s_infinite]" />
                        )}
                        {session.status}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 세션 생성 버튼 — 노드가 alive일 때만 */}
            {!isDead && (
              <div className="pl-8 pb-1">
                <NewSessionDialog nodeId={node.nodeId} nodeColor={color} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
