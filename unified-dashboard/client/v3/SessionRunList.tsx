import type { MouseEvent } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import type { RunTreeNode } from "./folder-workspace-run-model";
import { RichSessionRow } from "./RichSessionRow";
import "./v3-run-history.css";

export function SessionRunList({ tree, activeSessionId, onOpenSession, onContextMenu }: {
  tree: readonly RunTreeNode[];
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  return <div className="v3-run-list">
    {tree.map(node => <RunNode key={node.session.agentSessionId} node={node} depth={0}
      activeSessionId={activeSessionId} onOpenSession={onOpenSession} onContextMenu={onContextMenu} />)}
  </div>;
}

function RunNode({
  node,
  depth,
  activeSessionId,
  onOpenSession,
  onContextMenu,
}: {
  node: RunTreeNode;
  depth: number;
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const { session } = node;
  if (node.loadState === "loading") {
    return (
      <div className={depth > 0 ? "v3-run-children" : undefined}>
        <div className="v3-run-row v3-run-row--loading" data-depth={depth} aria-label="세션 정보 불러오는 중" aria-busy="true">
          <span className="v3-run-skeleton v3-run-skeleton--avatar" />
          <span className="v3-run-skeleton-copy">
            <span className="v3-run-skeleton v3-run-skeleton--title" />
            <span className="v3-run-skeleton v3-run-skeleton--preview" />
          </span>
          <span className="v3-run-skeleton v3-run-skeleton--badge" />
        </div>
      </div>
    );
  }
  const failed = node.loadState === "failed";
  return (
    <div className={depth > 0 ? "v3-run-children" : undefined}>
      <RichSessionRow
        session={session}
        runNumber={node.runNumber}
        failed={failed}
        active={!failed && session.agentSessionId === activeSessionId}
        onOpen={onOpenSession}
        onContextMenu={onContextMenu}
      />
      {node.children.map((child) => (
        <RunNode
          key={child.session.agentSessionId}
          node={child}
          depth={depth + 1}
          activeSessionId={activeSessionId}
          onOpenSession={onOpenSession}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}
