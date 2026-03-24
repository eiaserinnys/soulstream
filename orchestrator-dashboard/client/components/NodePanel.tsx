/**
 * NodePanel -- 좌측 하단에 위치하는 노드 목록 패널.
 *
 * orchestrator-store에서 노드 정보를, useDashboardStore에서 세션 목록을 가져와
 * 노드별로 그룹핑하여 표시한다.
 */

import { useMemo } from "react";
import { cn, Badge, useDashboardStore } from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { nodeColor } from "./NodeHeader";
import { NewSessionDialog } from "./NewSessionDialog";

export function NodePanel() {
  const nodes = useOrchestratorStore((s) => s.nodes);
  const sessions = useDashboardStore((s) => s.sessions);

  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);

  // 세션을 nodeId별로 그룹핑
  const sessionsByNode = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const nodeId = s.nodeId ?? "unknown";
      if (!map.has(nodeId)) map.set(nodeId, []);
      map.get(nodeId)!.push(s);
    }
    return map;
  }, [sessions]);

  if (nodeList.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-1.5 shrink-0 border-b border-border">
          <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
            Nodes
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/40 text-xs">
          No nodes
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 shrink-0 border-b border-border">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
          Nodes
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {nodeList.map((node, index) => {
          const color = nodeColor(index);
          const nodeSessions = sessionsByNode.get(node.nodeId) ?? [];
          const isDead = node.status === "disconnected";

          return (
            <div key={node.nodeId} className="border-b border-border">
              {/* Node header row */}
              <div className="flex items-center gap-2 px-3 py-2 select-none">
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

              {/* Session list */}
              {nodeSessions.length > 0 && (
                <div className="pl-8">
                  {nodeSessions.map((session) => {
                    const isRunning = session.status === "running";

                    return (
                      <div
                        key={session.agentSessionId}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 border-b border-border/40 transition-colors",
                          isDead
                            ? "opacity-40 cursor-not-allowed"
                            : "cursor-pointer hover:bg-muted",
                        )}
                        onClick={() => {
                          if (!isDead) {
                            useDashboardStore.getState().setActiveSession(session.agentSessionId);
                          }
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-mono text-muted-foreground/70 truncate">
                            {session.agentSessionId.slice(0, 8)}...
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

              {/* New session button -- only when node is alive */}
              {!isDead && (
                <div className="pl-8 pb-1">
                  <NewSessionDialog nodeId={node.nodeId} nodeColor={color} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
