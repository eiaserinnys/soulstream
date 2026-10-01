import { useState, type MouseEvent } from "react";
import { type SessionSummary } from "@seosoyoung/soul-ui";
import { RunRowFrame } from "./RunRowFrame";
import { Folder } from "lucide-react";

import {
  latestRun,
  plannerStatusPresentation,
} from "./planner-model";
import type { PlannerFolder } from "./planner-data";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { buildFolderContextMenuActions } from "./context-menu-model";
import {
  singleLinePreview,
  TASK_TITLE_PREVIEW_LENGTH,
} from "./session-preview";
import { useFolderStar } from "./use-folder-star";
import {
  sessionPresentationStatus,
  type SessionNodeConnectivity,
} from "./session-node-connectivity";
import "./v3-content-boundary.css";

type PlannerFolderCardProps = {
  task: PlannerFolder;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  isInToday: boolean;
  onOpen(): void;
  onComplete(): Promise<void>;
  onToggleToday(): Promise<void>;
  onMoveToParent(): void;
  navigationLabel?: string;
  onRename?(): void;
  onArchive?(): void;
};

export function PlannerFolderCard(props: PlannerFolderCardProps) {
  const folderStar = useFolderStar(props.task.page);
  return <PlannerFolderCardView {...props} folderStar={folderStar} />;
}

/** Same operational markup, with state and mutation callbacks supplied by its owner. */
export function PlannerFolderCardView({
  task,
  sessions,
  nodeConnectivity,
  isInToday,
  onOpen,
  onComplete,
  onToggleToday,
  onMoveToParent,
  navigationLabel,
  onRename,
  onArchive,
  folderStar,
}: PlannerFolderCardProps & { folderStar: ReturnType<typeof useFolderStar> }) {
  const [contextMenu, setContextMenu] = useState<V3ContextMenuTarget | null>(null);
  const status = plannerStatusPresentation(task.status);
  const run = latestRun(task.sessionIds, sessions);
  const runStatus = run ? sessionPresentationStatus(run.session, nodeConnectivity) : null;
  const showAssignee = task.assignee !== "담당 미지정" && task.assignee !== "담당 미확인";
  const showRun = runStatus === "running" || runStatus === "offline";
  const runState = runStatus === "offline" ? "노드 오프라인" : "실행 중";
  const openContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <>
      <RunRowFrame size="small" variant="folder"
        onOpen={onOpen} openLabel={`${task.page.title} 폴더 열기`}
        onContextMenu={openContextMenu} testId={`v3-task-${task.page.id}`}
        avatar={<Folder aria-hidden="true"/>}
        title={<strong title={task.page.title}>{singleLinePreview(task.page.title, TASK_TITLE_PREVIEW_LENGTH)}</strong>}
        agentLine={showAssignee ? <span>{task.assignee}</span> : null}
        status={{label:navigationLabel ?? (task.status === "in_progress" || task.status === "review" ? `카드 집계 · ${status.label}` : `폴더 ${task.status === "open" ? "열림" : status.label}`),tone:navigationLabel?undefined:task.status}}
        secondaryStatus={showRun && run ? {label:`세션 #${run.number} ${runState}`,tone:runStatus??undefined} : undefined}
        actions={[
          ...(onRename ? [{kind:"menu" as const,label:`${task.page.title} 관리 메뉴`,onAction:(event:MouseEvent<HTMLButtonElement>)=>{const rect=event.currentTarget.getBoundingClientRect();setContextMenu({x:rect.left,y:rect.bottom});}}] : []),
          {kind:"star",label:`${task.page.title} ${folderStar.starred?"별표 해제":"별표 추가"}`,pressed:folderStar.starred,pending:folderStar.pending,onAction:()=>{void folderStar.toggle();}},
        ]}/>

      <V3ContextMenu
        target={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={buildFolderContextMenuActions({
          starred: folderStar.starred,
          completed: task.status === "completed",
          inToday: isInToday,
        }, {
          open: onOpen,
          copyId: () => navigator.clipboard.writeText(task.folderId),
          toggleStar: folderStar.toggle,
          moveToParent: onMoveToParent,
          complete: onComplete,
          toggleToday: onToggleToday,
          rename: onRename,
          archive: onArchive,
        })}
      />
    </>
  );
}
