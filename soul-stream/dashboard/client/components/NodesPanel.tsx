/**
 * NodesPanel — 좌측 전체. 노드 헤더 요약 + 노드 컬럼들 가로 스크롤.
 */

import { useOrchestratorStore, totalSessionCount, sessionCountByStatus } from "../store/orchestrator-store";
import { NodeColumn } from "./NodeColumn";

export function NodesPanel() {
  const nodes = useOrchestratorStore((s) => s.nodes);
  const sessions = useOrchestratorStore((s) => s.sessions);
  const selectedNodeId = useOrchestratorStore((s) => s.selectedNodeId);
  const selectedSessionId = useOrchestratorStore((s) => s.selectedSessionId);
  const selectNode = useOrchestratorStore((s) => s.selectNode);
  const selectSession = useOrchestratorStore((s) => s.selectSession);

  const nodeArray = Array.from(nodes.values());
  const total = totalSessionCount(sessions);
  const running = sessionCountByStatus(sessions, "running");
  const completed = sessionCountByStatus(sessions, "completed");

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r border-border">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[13px] font-medium text-muted-foreground tracking-[1.5px] uppercase font-mono">
            Soul Nodes
          </h2>
          <span className="text-[11px] font-mono bg-muted text-muted-foreground px-2 py-px rounded">
            {nodeArray.length} nodes
          </span>
        </div>
        <div className="flex gap-3 text-[11px] font-mono text-muted-foreground/50">
          <span>
            <span className="font-medium text-success">{running}</span> running
          </span>
          <span>
            <span className="font-medium text-muted-foreground">{completed}</span> completed
          </span>
          <span>
            <span className="font-medium">{total}</span> total sessions
          </span>
        </div>
      </div>

      {/* Node columns — horizontal scroll */}
      <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
        {nodeArray.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/30 font-mono text-sm">
            Waiting for nodes to connect...
          </div>
        ) : (
          nodeArray.map((node, i) => (
            <NodeColumn
              key={node.nodeId}
              node={node}
              colorIndex={i}
              sessions={sessions.get(node.nodeId) ?? []}
              selectedNodeId={selectedNodeId}
              selectedSessionId={selectedSessionId}
              onNodeClick={selectNode}
              onSessionClick={selectSession}
            />
          ))
        )}
      </div>
    </div>
  );
}
