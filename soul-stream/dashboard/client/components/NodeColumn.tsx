/**
 * NodeColumn — 개별 노드 컬럼. NodeHeader + SessionCard 목록.
 */

import type { OrchestratorNode, OrchestratorSession } from "../store/types";
import { NodeHeader } from "./NodeHeader";
import { SessionCard } from "./SessionCard";

interface NodeColumnProps {
  node: OrchestratorNode;
  colorIndex: number;
  sessions: OrchestratorSession[];
  selectedNodeId: string | null;
  selectedSessionId: string | null;
  onNodeClick: (nodeId: string) => void;
  onSessionClick: (nodeId: string, sessionId: string) => void;
}

export function NodeColumn({
  node,
  colorIndex,
  sessions,
  selectedNodeId,
  selectedSessionId,
  onNodeClick,
  onSessionClick,
}: NodeColumnProps) {
  const isNodeSelected =
    selectedNodeId === node.nodeId && selectedSessionId === null;

  return (
    <div className="flex-none w-[280px] flex flex-col h-full border-r border-border last:border-r-0 overflow-hidden">
      <NodeHeader
        node={node}
        colorIndex={colorIndex}
        isSelected={isNodeSelected}
        sessionCount={sessions.length}
        onClick={() => onNodeClick(node.nodeId)}
      />

      {/* Session list header */}
      <div className="px-3.5 py-2 flex items-center justify-between shrink-0">
        <span className="text-[11px] font-mono text-muted-foreground/50 uppercase tracking-widest">
          Sessions
        </span>
        <span className="text-[10px] font-mono bg-muted text-muted-foreground/50 px-1.5 py-px rounded">
          {sessions.length}
        </span>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-1">
        {sessions.length === 0 ? (
          <div className="text-xs text-muted-foreground/30 text-center py-8 font-mono">
            No sessions
          </div>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              isSelected={selectedSessionId === session.sessionId}
              isActive={session.status === "running"}
              onClick={() => onSessionClick(node.nodeId, session.sessionId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
