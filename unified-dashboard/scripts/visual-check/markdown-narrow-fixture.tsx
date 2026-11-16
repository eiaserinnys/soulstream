// 카드 #1342 시각 검수 표본. 마크다운을 그리는 표면 여덟을 실제 카드 문서처럼
// 한글 문장과 커밋 해시, 긴 주소가 섞인 내용으로 세우고, 좁은 폭에서 줄바꿈과 넘침을 잰다.
// 시각 검수 스크립트(markdown_narrow.py)가 `?surface=`로 하나씩 연다.
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import "../../client/v3/v3-cards.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { ChatUiFallback } from "@seosoyoung/soul-ui/components/chat-ui/ChatUiMessage";
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
const URL_LONG = "https://github.com/eiaserinnys/soulstream/pull/1933/files#diff-4f9b2c71e0a8d3b6c5e7f1a2d4b6c8e0f2a4c6e8";

// 실제 카드 문서처럼 한글 문장과 커밋 해시, 코드가 섞인 본문. 「표본입니다」와
// 「확인합니다」는 낱말 중간에서 끊기는지 재는 표본 낱말이다.
// remark-breaks가 문단 안의 단일 줄바꿈을 강제 줄바꿈으로 바꾸므로, 접힘을 재는
// 문단은 한 줄로 길게 쓴다.
const documentBody = [
  "# 정리 작업 모음",
  "",
  "표본입니다. 좁은 폭에서도 한글 낱말이 글자 단위로 끊기지 않아야 하며, 끊을 곳이 없는 긴 해시만 글자 단위로 끊여야 합니다. 이 문단은 낱말 경계에서만 줄이 바뀌는지 확인합니다.",
  "",
  `자세한 변경은 ${URL_LONG} 에서 볼 수 있습니다.`,
  "",
  `[변경 파일 목록 보기](${URL_LONG}) 링크도 함께 둡니다.`,
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
  `| [변경 파일 목록](${URL_LONG}) | 확인합니다 | 링크 칸입니다 |`,
  `| 표 칸의 긴 주소 | 확인합니다 | ${URL_LONG} |`,
  "",
  `인라인 코드 \`${HASH}\`도 낱말처럼 읽힙니다.`,
].join("\n");

const chatBody = [
  "정리한 결과를 보고합니다. 좁은 폭에서도 한글 낱말은 낱말 단위로 접히고, 긴 해시만 글자 단위로 끊깁니다. 확인합니다.",
  "",
  `자세한 변경은 ${URL_LONG} 에서 볼 수 있습니다.`,
  "",
  `- 커밋 ${HASH} 반영`,
  `- 짧은 해시 ${SHORT_HASH}`,
].join("\n");

// 스트리밍 평문과 완료 마크다운이 같은 글이 되도록 마크다운 문법 없이 한 문단으로 쓴다.
const streamText = "정리한 결과를 보고합니다. 좁은 폭에서도 한글 낱말은 낱말 단위로 접히고, 긴 해시 " + HASH
  + " 같은 것만 글자 단위로 끊깁니다. 스트리밍 중과 완료 뒤에 줄이 바뀌는 자리가 같아야 화면이 튀지 않습니다. 확인합니다.";

const userBody = "이 화면에서 한글 낱말이 끊기는지 봐 줘. 주소는 " + URL_LONG + " 이고 해시는 " + HASH + " 이야.";

const fallbackBody = "화면을 그리지 못한 답의 본문입니다.\n\n- 첫 항목\n- 둘째 항목";
const withdrawalBody = "이 질문을 거두었습니다. 결정할 내용이 바뀌었습니다.\n\n두 번째 문단입니다.";
const clampBody = "첫 문단입니다. 세 줄 자르기에서 낱말이 어떻게 접히는지 봅니다. 좁은 폭에서 줄 수가 달라질 수 있습니다.\n\n둘째 문단입니다. 더 보기를 누르기 전에는 세 줄까지만 보여야 합니다.\n\n셋째 문단입니다.";

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

const userMessage: ChatMessage = {
  id: "markdown-narrow-user",
  role: "user",
  treeNodeId: "markdown-narrow-user",
  treeNodeType: "user_message",
  content: userBody,
} as ChatMessage;

function streamMessage(id: string, streaming: boolean): ChatMessage {
  return {
    id,
    role: "assistant",
    treeNodeId: id,
    treeNodeType: "assistant_message",
    content: streamText,
    isStreaming: streaming,
  } as ChatMessage;
}

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

function ChatRoot({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-[520px] bg-background p-3" data-slot="chat-root">{children}</div>;
}

function ChatSurface() {
  return (
    <ChatRoot>
      <AssistantMessage msg={assistantMessage} />
    </ChatRoot>
  );
}

function UserSurface() {
  return (
    <ChatRoot>
      <div data-sel="root"><UserMessage msg={userMessage} /></div>
    </ChatRoot>
  );
}

function StreamSurface() {
  return (
    <ChatRoot>
      <div data-sel="streaming"><AssistantMessage msg={streamMessage("stream-s1", true)} /></div>
      <div data-sel="completed"><AssistantMessage msg={streamMessage("stream-s2", false)} /></div>
      <div data-sel="streaming-m"><AssistantMessage presentation="manuscript" msg={streamMessage("stream-s3", true)} /></div>
      <div data-sel="completed-m"><AssistantMessage presentation="manuscript" msg={streamMessage("stream-s4", false)} /></div>
    </ChatRoot>
  );
}

function SiblingsSurface() {
  return (
    <ChatRoot>
      <div data-sel="root" className="space-y-4">
        <div data-sel="fallback"><ChatUiFallback content={fallbackBody} notice="이 버전에서는 기본값 글로 보여줄게." /></div>
        <div data-sel="withdrawal" className="v3-card-timeline-body">
          <MarkdownContent content={withdrawalBody} />
          <p className="v3-card-question-withdrawal">담당이 다른 방법을 찾아 질문을 철회했습니다.</p>
        </div>
        <div data-sel="clamp" className="v3-card-three-lines"><MarkdownContent content={clampBody} /></div>
      </div>
    </ChatRoot>
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
  if (surface === "user") return <UserSurface />;
  if (surface === "stream") return <StreamSurface />;
  if (surface === "siblings") return <SiblingsSurface />;
  if (surface === "notes") return <NotesSurface />;
  if (surface === "question") return <QuestionSurface />;
  return <div>알 수 없는 표본</div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
