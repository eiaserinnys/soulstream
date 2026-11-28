import { useTranslation } from "react-i18next";
import type { SessionNodeConnectivity } from "@seosoyoung/soul-ui/lib/session-node-connectivity";
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
} from "./session-node-connectivity";
import "./v3-content-boundary.css";

type PlannerFolderCardProps = {
  task: PlannerFolder;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  onOpen(): void;
  onComplete(): Promise<void>;
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
  onOpen,
  onComplete,
  onMoveToParent,
  navigationLabel,
  onRename,
  onArchive,
  folderStar,
}: PlannerFolderCardProps & { folderStar: ReturnType<typeof useFolderStar> }) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<V3ContextMenuTarget | null>(null);
  const status = plannerStatusPresentation(task.status, t);
  const run = latestRun(task.sessionIds, sessions);
  const runStatus = run ? sessionPresentationStatus(run.session, nodeConnectivity) : null;
  const showAssignee = task.assignee !== "담당 미지정" && task.assignee !== "담당 미확인"; // i18n-ignore: Unassigned sentinel produced by planner-data, folder-workspace-model and use-folder-workspace-entry
  const showRun = runStatus === "running" || runStatus === "offline";
  const runState = runStatus === "offline" ? t("folders.planner.offline") : t("folders.planner.running");
  const openContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <>
      <RunRowFrame size="small" variant="folder"
        onOpen={onOpen} openLabel={t("folders.planner.openFolder", { name: task.page.title })}
        onContextMenu={openContextMenu} testId={`v3-task-${task.page.id}`}
        avatar={<Folder aria-hidden="true"/>}
        title={<strong title={task.page.title}>{singleLinePreview(task.page.title, TASK_TITLE_PREVIEW_LENGTH)}</strong>}
        agentLine={showAssignee ? <span>{task.assignee}</span> : null}
        status={{label:navigationLabel ?? (task.status === "in_progress" || task.status === "review" ? t("folders.planner.cardStatus", { status: status.label }) : t("folders.planner.folderStatus", { status: task.status === "open" ? t("folders.planner.folderOpen") : status.label })),tone:navigationLabel?undefined:task.status}}
        secondaryStatus={showRun && run ? {label:t("folders.planner.sessionRun", { number: run.number, status: runState }),tone:runStatus??undefined} : undefined}
        actions={[
          ...(onRename ? [{kind:"menu" as const,label:t("folders.planner.manageFolder", { name: task.page.title }),onAction:(event:MouseEvent<HTMLButtonElement>)=>{const rect=event.currentTarget.getBoundingClientRect();setContextMenu({x:rect.left,y:rect.bottom});}}] : []),
          {kind:"star",label:t(folderStar.starred ? "folders.planner.unstarFolder" : "folders.planner.starFolder", { name: task.page.title }),pressed:folderStar.starred,pending:folderStar.pending,onAction:()=>{void folderStar.toggle();}},
        ]}/>

      <V3ContextMenu
        target={contextMenu}
        onClose={() => setContextMenu(null)}
        actions={buildFolderContextMenuActions({
          starred: folderStar.starred,
          completed: task.status === "completed",
        }, {
          open: onOpen,
          copyId: () => navigator.clipboard.writeText(task.folderId),
          toggleStar: folderStar.toggle,
          moveToParent: onMoveToParent,
          complete: onComplete,
          rename: onRename,
          archive: onArchive,
        })}
      />
    </>
  );
}
