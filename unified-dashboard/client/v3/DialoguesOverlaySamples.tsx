import { useLayoutEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useIsMobile, FileAttachmentPreview, SessionContextMenu, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { ProjectDialog } from "./ProjectDialog";
import { saveProjectFormContext } from "./project-form-actions";
import { CardTimeline } from "./CardTimeline";
import { CardWorkspace } from "./CardWorkspace";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { PostItCardView } from "./PostItCard";
import { DocumentReaderDialog } from "./DocumentReaderDialog";
import { CardAttachmentReviewSamples } from "./CardAttachmentReviewSamples";
import { ChatAttachmentReviewSamples } from "./ChatAttachmentReviewSamples";
import { V3ContextMenu } from "./V3ContextMenu";
import { dialoguesFolders, dialoguesAssignment, createDialoguesApi } from "./dialogues-api";
import { reviewCard, reviewDetail, reviewSession } from "./components-review-fixtures";
import type { DialogueId } from "./dialogues-inventory";
import { activateRunSession } from "./folder-workspace-run-model";
import "./v3-card-board.css";
const readSampleDocument: typeof fetch = async () => Response.json({
  id: "sample-linked-document", title: "링크 문서 읽기", version: 1,
  body: "# 링크 문서 읽기\n\n" + Array.from({ length: 60 }, (_, index) => `문단 ${index + 1}. 채팅에서 인용한 문서를 읽습니다. 긴 본문은 다이얼로그 안에서 끝까지 스크롤할 수 있습니다.`).join("\n\n"),
});
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
  if (id === "card-attachments") return <CardAttachmentReviewSamples />;
  if (id === "chat-attachments") return <ChatAttachmentReviewSamples />;
  if (id === "reference-add" || id === "reference-edit")
    return (
      <ProjectDialog
        target={{ mode: "edit", folder }}
        folders={dialoguesFolders}
        initialEditor={id}
        request={api.request}
        assignment={dialoguesAssignment}
        onClose={onClose}
        onCreateIdentity={async () => folder}
        onRename={async () => undefined}
        onSaveContext={(pageId, previous, value, attempt) => saveProjectFormContext(pageApi, pageId, previous, value, attempt)}
        onSaved={() => done("참고 자료 저장")}
      />
    );
  if (id === "card-image" || id === "card-image-screen")
    return (
      <CardTimeline
        card={reviewCard}
        detail={reviewDetail}
        portraitUrl="/system-portrait.png"
        initialImage={id === "card-image-screen"
          ? { src: "/image-viewer-screen.png", alt: "화면 캡처" }
          : { src: "/icon-192.png", alt: "검수 이미지" }}
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
  if (id === "document-reader") return <DocumentReaderDialog documentId="sample-linked-document"
    request={new URLSearchParams(window.location.search).get("loading") === "1"
      ? globalThis.fetch.bind(globalThis)
      : readSampleDocument}
    onClose={onClose}/>;
  if (id === "v3-sheet")
    return (
      <V3ContextMenu
        target={{ x: 0, y: 0 }}
        actions={[{ label: "새 카드", onSelect: () => done("작업 액션") }]}
        onClose={onClose}
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
