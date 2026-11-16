// 카드 #1342 시각 검수 표본. 마크다운을 그리는 표면 다섯을 실제 카드 문서처럼
// 한글 문장과 커밋 해시가 섞인 내용으로 세우고, 좁은 폭에서 줄바꿈과 넘침을 잰다.
// 시각 검수 스크립트(markdown_narrow.py)가 `?surface=`로 하나씩 연다.
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { CardComment } from "@seosoyoung/soul-ui/cards/card-types";
import { CardNotes } from "../../client/v3/CardNotes";
import { CardQuestionBody, type CardQuestionView } from "../../client/v3/CardQuestionBlock";
import { DocumentReaderDialog } from "../../client/v3/DocumentReaderDialog";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "attachment";
const state = params.get("state") ?? "ready";
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const HASH = "8c05d01e24f96b70a612750a4f45795bacdab636";
const SHORT_HASH = "6c9daa2d4";

// 실제 카드 문서처럼 한글 문장과 커밋 해시, 코드가 섞인 본문. 「표본입니다」와
// 「확인합니다」는 낱말 중간에서 끊기는지 재는 표본 낱말이다.
// remark-breaks가 문단 안의 단일 줄바꿈을 강제 줄바꿈으로 바꾸므로, 접힘을 재는
// 문단은 한 줄로 길게 쓴다.
const documentBody = [
  "# 정리 작업 모음",
  "",
  "표본입니다. 좁은 폭에서도 한글 낱말이 글자 단위로 끊기지 않아야 하며, 끊을 곳이 없는 긴 해시만 글자 단위로 끊여야 합니다. 이 문단은 낱말 경계에서만 줄이 바뀌는지 확인합니다.",
  "",
  "## 남은 일",
  "",
  `- 커밋 ${HASH}의 변경분을 다시 확인합니다.`,
  `- 짧은 해시 ${SHORT_HASH}가 든 줄도 같은 규칙으로 접힙니다.`,
  "- `corepack pnpm -C unified-dashboard exec vitest run`으로 단위 시험을 확인합니다.",
  "",
  "## 확인 표",
  "",
  "| 항목 | 상태 | 해시 |",
  "| --- | --- | --- |",
  `| 줄바꿈을 확인합니다 | 확인합니다 | \`${HASH}\` |`,
  `| 표 넘침을 확인합니다 | 확인합니다 | ${HASH} |`,
  "",
  `인라인 코드 \`${HASH}\`도 낱말처럼 읽힙니다.`,
].join("\n");

const chatBody = [
  "정리한 결과를 보고합니다. 좁은 폭에서도 한글 낱말은 낱말 단위로 접히고, 긴 해시만 글자 단위로 끊깁니다. 확인합니다.",
  "",
  `- 커밋 ${HASH} 반영`,
  `- 짧은 해시 ${SHORT_HASH}`,
].join("\n");

const briefBody = [
  "카드 담당이 인계 요약을 남깁니다. 남은 일은 좁은 폭 화면에서 한글 낱말이 끊기지 않는지 확인합니다.",
  "",
  `마지막 커밋은 ${HASH}입니다.`,
].join("\n");

const noteBody = [
  `노트 본문입니다. 표본입니다 문장은 낱말 단위로 접혀야 하고, 해시 ${HASH}는 필요할 때만 글자 단위로 끊깁니다. 확인합니다.`,
].join("\n");

const questionBackground = [
  "질문 장 배경입니다. 이 결정이 좁은 폭에서도 읽히는지 확인합니다.",
  "",
  `- 대상 커밋 ${HASH}`,
  "- 바뀐 화면은 첨부 보기 창 문서와 문서 읽기 창입니다.",
].join("\n");

function documentItem(): ChatAttachmentItem {
  const file = new File([documentBody], "정리 작업 모음.md", { type: "text/markdown" });
  return {
    key: "local:markdown-narrow-document",
    name: file.name,
    mimeType: file.type,
    byteSize: file.size,
    previewKind: "text",
    availability: "ready",
    previewUrl: null,
    originalUrl: null,
    legacySources: [],
    source: { kind: "local", file },
  };
}

const assistantMessage: ChatMessage = {
  id: "markdown-narrow-chat",
  role: "assistant",
  treeNodeId: "markdown-narrow-chat",
  treeNodeType: "assistant_message",
  content: chatBody,
} as ChatMessage;

const note: CardComment = {
  id: "markdown-narrow-note",
  cardId: "card-1",
  authorKind: "agent",
  authorId: "로젤린",
  sessionId: null,
  kind: "note",
  body: noteBody,
  createdAt: "2026-11-16T07:00:00.000Z",
};

const questionView: CardQuestionView = {
  id: "markdown-narrow-question",
  title: null,
  background: questionBackground,
  kind: "choice",
  options: [{ label: "확인했습니다", description: null, recommended: false }],
  attachments: [],
  thread: [],
  open: true,
  selectedOption: null,
  answer: null,
  revisedAt: null,
  awaitingAgent: false,
};

function AttachmentSurface() {
  const [index, setIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activate = () => setIndex(0);
  const opened = index !== null;
  useEffect(() => {
    if (state === "auto") activate();
  }, []);
  return (
    <div className="p-3">
      <button ref={triggerRef} type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={activate}>
        첨부 문서 열기
      </button>
      {opened ? (
        <AttachmentViewer
          items={[documentItem()]}
          index={index}
          onIndexChange={setIndex}
          onClose={() => {
            setIndex(null);
            requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
          }}
        />
      ) : null}
    </div>
  );
}

function DocumentReaderSurface() {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activate = () => setDocumentId("markdown-narrow-document");
  useEffect(() => {
    // error 상태도 창을 연 채로 실패 안내를 그려야 한다.
    if (state === "auto" || state === "error") activate();
  }, []);
  const request = async () => state === "error"
    ? new Response(JSON.stringify({ detail: "doc not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({
      id: "markdown-narrow-document",
      title: "정리 작업 모음",
      body: documentBody,
      version: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  return (
    <div className="p-3">
      <button ref={triggerRef} type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={activate}>
        문서 읽기 창 열기
      </button>
      <DocumentReaderDialog
        documentId={documentId}
        request={request as typeof fetch}
        onClose={() => {
          setDocumentId(null);
          requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
        }}
      />
    </div>
  );
}

function ChatSurface() {
  return (
    <div className="w-full max-w-[520px] bg-background p-3" data-slot="chat-root">
      <AssistantMessage msg={assistantMessage} />
    </div>
  );
}

function NotesSurface() {
  return <div className="p-3"><CardNotes brief={briefBody} notes={[note]} /></div>;
}

function QuestionSurface() {
  return <div className="p-3"><CardQuestionBody view={questionView} portraitUrl={null} /></div>;
}

function Fixture() {
  if (surface === "attachment") return <AttachmentSurface />;
  if (surface === "document-reader") return <DocumentReaderSurface />;
  if (surface === "chat") return <ChatSurface />;
  if (surface === "notes") return <NotesSurface />;
  if (surface === "question") return <QuestionSurface />;
  return <div>알 수 없는 표본</div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
