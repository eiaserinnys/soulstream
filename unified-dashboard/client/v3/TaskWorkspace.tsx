import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChatView,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  DEFAULT_WORKSPACE_SPLIT,
  buildRunTree,
  clampWorkspaceSplit,
  workspaceSplitForKey,
} from "./task-workspace-model";
import { TaskDetailPane } from "./TaskDetailPane";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";

export function TaskWorkspace({
  task,
  projectTitle,
  sessions,
  activeSession,
  chatOpen,
  chatInputDisabled,
  fileUploadUrl,
  sessionDefaults,
  onReturnToPlanner,
  onCloseChat,
  onOpenBoard,
  onOpenSession,
  onSaveDescription,
  onPromoteDocument,
  onAcknowledgedReview,
}: {
  task: PlannerTask;
  projectTitle: string;
  sessions: readonly SessionSummary[];
  activeSession: SessionSummary | undefined;
  chatOpen: boolean;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  sessionDefaults: PageSessionDefaults | null;
  onReturnToPlanner(): void;
  onCloseChat(): void;
  onOpenBoard(): void;
  onOpenSession(session: SessionSummary): void;
  onSaveDescription(markdown: string): Promise<void>;
  onPromoteDocument(blockId: string): Promise<void>;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);

  useEffect(() => {
    if (!chatOpen) draggingPointer.current = null;
  }, [chatOpen]);

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    setSplitPercent(clampWorkspaceSplit(((event.clientX - bounds.left) / bounds.width) * 100));
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current === event.pointerId) updateFromPointer(event);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) return;
    draggingPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={`v3-workspace-scrim${chatOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onReturnToPlanner(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${chatOpen ? " is-chat-open" : ""}`}
        style={chatOpen ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 4px)) 8px minmax(0, 1fr)` } : undefined}
      >
        <TaskDetailPane
          task={task}
          sessions={sessions}
          sessionDefaults={sessionDefaults}
          onReturnToPlanner={onReturnToPlanner}
          onOpenBoard={onOpenBoard}
          onOpenSession={onOpenSession}
          onSaveDescription={onSaveDescription}
          onPromoteDocument={onPromoteDocument}
        />
        {chatOpen ? (
          <>
            <div
              className="v3-workspace-divider"
              role="separator"
              tabIndex={0}
              aria-label="상세와 채팅 너비 조절"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(splitPercent)}
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onDoubleClick={() => setSplitPercent(DEFAULT_WORKSPACE_SPLIT)}
              onKeyDown={(event) => {
                const next = workspaceSplitForKey(splitPercent, event.key);
                if (next === null) return;
                event.preventDefault();
                setSplitPercent(next);
              }}
            ><span /></div>
            <section className="v3-chat-pane" aria-label="Run 채팅">
              <header className="v3-chat-header">
                <div><small>{projectTitle} › {task.page.title}</small><strong>{runLabel(task, activeSession, sessions)}</strong></div>
                <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>{activeSession?.status === "running" ? "실행 중" : "완료"}</span>
                <button type="button" aria-label="채팅 닫기" onClick={onCloseChat}>×</button>
              </header>
              <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} />
              <div className="v3-chat-content">
                <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} />
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function runLabel(
  task: PlannerTask,
  session: SessionSummary | undefined,
  sessions: readonly SessionSummary[],
): string {
  if (!session) return "Run";
  const roots = buildRunTree(task.sessionIds, sessions);
  const root = roots.find((node) => node.session.agentSessionId === session.agentSessionId);
  if (root?.runNumber) return `run #${root.runNumber}`;
  return session.displayName ?? session.agentName ?? "위임 세션";
}
