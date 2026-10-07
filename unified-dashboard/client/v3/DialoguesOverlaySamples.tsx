import {createPortal} from "react-dom";
import { useLayoutEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useIsMobile, FileAttachmentPreview, SessionContextMenu, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { FolderContextMenu } from "@seosoyoung/soul-ui/components/FolderContextMenu";
import { MarkdownDocumentPanel } from "@seosoyoung/soul-ui/components/MarkdownDocumentPanel";
import {
  fetchMarkdownDocument,
  updateMarkdownDocument,
  deleteMarkdownDocument,
} from "@seosoyoung/soul-ui/lib/markdown-document-operations";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { ProjectContextEditor } from "./ProjectContextEditor";
import { CardTimeline } from "./CardTimeline";
import { CardWorkspace } from "./CardWorkspace";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { PostItCardView } from "./PostItCard";
import { FolderDocumentOverlay } from "./FolderDocumentOverlay";
import { V3ContextMenu } from "./V3ContextMenu";
import { dialoguesFolders, dialoguesAssignment, createDialoguesApi } from "./dialogues-api";
import { reviewCard, reviewDetail, reviewFolder, reviewSession } from "./components-review-fixtures";
import type { DialogueId } from "./dialogues-inventory";
import { activateRunSession } from "./folder-workspace-run-model";
import "./v3-card-board.css";
export function DialoguesOverlaySamples({
  id,
  api,
  onClose,
  onChanged,
}: {
  id: DialogueId;
  api: ReturnType<typeof createDialoguesApi>;
  onClose(): void;
  onChanged(): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [selectedSession,setSelectedSession]=useState<SessionSummary>();
  const [mobileTab,setMobileTab]=useState("projects");
  const queryClient=useQueryClient();
  useLayoutEffect(()=>{
    if(id==="card-detail")queryClient.setQueryData(["sessions","ids",null,[reviewSession.agentSessionId]],{
      pages:[{sessions:[reviewSession],total:1}],pageParams:[0],
    });
  },[id,queryClient]);
  const mobile = useIsMobile();
  const pageApi = useMemo(() => createPageApiClient({ fetch: api.request }), [api]);
  const folder = api.local.folder;
  const done = (name: string) => {
    api.record(name);
    onChanged();
    onClose();
  };
  const image = useMemo(
    () =>
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="steelblue"/><text x="20" y="65" fill="white">Soulstream</text></svg>',
        ],
        "검수 이미지.svg",
        { type: "image/svg+xml" },
      ),
    [],
  );
  if (["atom-add", "atom-edit", "defaults-add", "defaults-edit"].includes(id))
    return (
      <ProjectContextEditor
        initialEditor={id as "atom-add" | "atom-edit" | "defaults-add" | "defaults-edit"}
        pageId={folder.id}
        api={pageApi}
        request={api.request}
        assignment={dialoguesAssignment}
        snapshot={{
          page: reviewFolder(folder.name, folder.id).page,
          blocks: [],
          stateVector: "",
          guidance: [],
          atomReferences:
            id === "atom-edit"
              ? [
                  {
                    blockId: "sample-atom-block",
                    instance: "atom",
                    nodeId: "sample-atom",
                    nodeTitle: "검수 지식",
                    depth: 3,
                    titlesOnly: false,
                  },
                ]
              : [],
          sessionDefaults:
            id === "defaults-edit"
              ? [
                  {
                    blockId: "sample-default-block",
                    scope: "project",
                    nodeId: "sample-node",
                    agentId: "roselin",
                    modelPreset: "sample-sol",
                  },
                ]
              : [],
        }}
        onChanged={async () => done("프로젝트 컨텍스트 저장")}
      />
    );
  if (id === "card-image")
    return (
      <CardTimeline
        card={reviewCard}
        detail={reviewDetail}
        portraitUrl="/system-portrait.png"
        initialImage={{ src: "/icon-192.png", alt: "검수 이미지" }}
        onAnswer={() => done("샘플 응답")}
        pending={false}
      />
    );
  if (id === "file-image")
    return <FileAttachmentPreview initialImageOpen file={image} status="done" onRemove={onClose} />;
  if (id === "card-detail")
    return (
      <CardWorkspace
        cardId={reviewCard.id}
        sampleDetail={reviewDetail}
        folders={dialoguesFolders}
        onClose={onClose}
        onCloseChat={()=>setMobileTab("today")}
        onOpenSession={session=>{
          activateRunSession(session,useDashboardStore.getState());setSelectedSession(session);setMobileTab("chat");
          api.record("샘플 세션 열기");onChanged();
        }}
        mobileMode={mobile}
        mobileTab={mobileTab}
        activeSession={selectedSession}
        chatInputDisabled
        historyEnabled={false}
        sessionStreamActive={false}
        sessionConnectionStatus="disconnected"
        reconnectSession={() => {}}
        onAcknowledgedReview={() => {}}
      />
    );
  if (id === "card-board")
    return (
      <CardBoardWorkspace
        initialExpanded
        title="검수 카드"
        cards={[reviewCard]}
        renderCard={(card) => <PostItCardView card={card} activity={null} onOpen={() => done("보드 카드 열기")} />}
      />
    );
  if (id === "document-overlay")
    return createPortal(
      <div className="v3-workspace-scrim is-chat-open is-task-board">
        <div className="v3-workspace is-board-open v3-folder-board-workspace">
          <FolderDocumentOverlay
            expanded={expanded}
            projectTitle="검수 프로젝트"
            folderTitle={folder.name}
            onToggleExpanded={() => setExpanded((value) => !value)}
            onClose={onClose}
          >
            <MarkdownDocumentPanel
              documentId="sample-document"
              container={null}
              onPendingEditConsumed={() => {}}
              onClose={onClose}
              onDeleted={() => done("보드 문서 삭제")}
              actions={{
                read: (id) => fetchMarkdownDocument(id, api.request),
                update: (value) => updateMarkdownDocument(value, api.request),
                remove: (id) => deleteMarkdownDocument(id, api.request),
              }}
            />
          </FolderDocumentOverlay>
        </div>
      </div>, document.querySelector(".v3-shell")!
    );
  if (id === "v3-sheet")
    return (
      <V3ContextMenu
        target={{ x: 0, y: 0 }}
        actions={[{ label: "새 카드", onSelect: () => done("작업 액션") }]}
        onClose={onClose}
      />
    );
  if (id === "folder-sheet")
    return (
      <FolderContextMenu
        target={{ x: 0, y: 0, folder }}
        onClose={onClose}
        onRename={() => done("폴더 이름 변경")}
        onOpenSettings={() => done("폴더 설정")}
        onDelete={() => done("폴더 보관")}
      />
    );
  if (id === "session-sheet")
    return (
      <SessionContextMenu
        contextMenu={{ x: 0, y: 0, sessionId: reviewSession.agentSessionId }}
        onClose={onClose}
        getSessionName={() => "검수 세션"}
        resolveSessionIds={(id) => [id]}
        onRenameSession={async () => done("세션 이름 변경")}
        onDeleteSessions={async () => done("세션 삭제")}
        onContinueSession={async () => done("세션 승계")}
        actions={{
          getResumeAfterLimitEligibility: async () => ({
            eligible: false,
            reason: "샘플",
            resets_at: null,
            schedule: null,
          }),
          scheduleResumeAfterLimit: async () => {
            throw new Error("샘플 세션은 예약하지 않습니다.");
          },
          deleteClaudeSchedule: async (sessionId, scheduleId) => ({
            sessionId,
            scheduleId,
            deleted: true,
            status: "deleted",
            schedule: null,
          }),
        }}
      />
    );
  return null;
}
