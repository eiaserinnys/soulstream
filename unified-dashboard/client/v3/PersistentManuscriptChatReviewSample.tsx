import { useMemo, useRef, useState } from "react";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { FileAttachmentPreview } from "@seosoyoung/soul-ui/components/FileAttachmentPreview";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import { PaperclipButton } from "@seosoyoung/soul-ui/components/chat/PaperclipButton";
import { Button } from "@seosoyoung/soul-ui/components/ui/button";
import { Square } from "lucide-react";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";

function makeMessage(role: ChatMessage["role"], id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content: "",
    treeNodeId: `review-${id}`,
    treeNodeType: role,
    ...extra,
  } as ChatMessage;
}

const messages: ChatMessage[] = [
  makeMessage("assistant", "long-answer", {
    content: "이 결과는 입력과 첨부를 같은 전송 경로로 처리합니다.\n\n한글 문장이 긴 경우에도 낱말 중간을 먼저 나누지 않고, 열 폭을 넘어가는 긴 문자열은 화면 안에서 접습니다. 다음 문단도 기존 Markdown 렌더러가 같은 글자 설정으로 보여 줍니다.",
  }),
  makeMessage("assistant", "streaming", {
    content: "지금은 응답을 이어 쓰고 있습니다.",
    isStreaming: true,
  }),
  makeMessage("user", "user-message", {
    content: "내 입력은 오른쪽에 놓입니다.\n줄바꿈과 긴 한글 단어도 보존합니다.",
  }),
  makeMessage("intervention", "intervention", {
    content: "실행 중인 작업에 보낸 개입 메시지입니다.",
  }),
  makeMessage("user", "attachments", {
    content: "첨부를 눌러 열 수 있습니다.\n\n![샘플 이미지](/icon-192.png)\n\n[검수 메모.pdf 열기](https://example.com/review-note.pdf)",
  }),
  makeMessage("tool_approval", "approval", {
    content: "파일을 수정하기 전에 승인이 필요합니다.",
    approvalId: "components-review-approval",
    approvalResolved: false,
  }),
  makeMessage("tool", "tool", {
    content: "Read · packages/soul-ui/src/components/chat/ChatView.tsx",
    toolName: "Read",
  }),
  makeMessage("system", "error", {
    content: "응답 연결이 끊겼습니다. 다시 시도할 수 있습니다.",
    treeNodeType: "error",
    isError: true,
  }),
  makeMessage("system", "jev", {
    content: "",
    treeNodeType: "persistent_jev_candidates",
    jevCandidates: [{
      label: "#412",
      line: "입력과 같은 대화 아래에 표시되는 Jev 후보",
      score: 2,
    }],
  }),
  makeMessage("system", "generation", {
    content: "",
    treeNodeType: "generation_started",
  }),
];

function ReviewComposer({ multiline, presentation, running = false, sampleId }: { multiline: boolean; presentation: "default" | "manuscript"; running?: boolean; sampleId: string }) {
  const [text, setText] = useState(multiline ? "첫 줄 입력\n둘째 줄 입력" : "");
  const [actionStatus, setActionStatus] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { chatTypographyStyle } = useChatTypography();
  const file = useMemo(
    () => new File(["검수 첨부 내용"], "검수 메모.txt", { type: "text/plain" }),
    [],
  );
  const imageFile = useMemo(
    () => new File(["<svg xmlns='http://www.w3.org/2000/svg' width='96' height='64'><rect width='96' height='64' fill='#d6d6ce'/></svg>"], "검수 이미지.svg", { type: "image/svg+xml" }),
    [],
  );
  useTextareaAutoHeight(textareaRef, text, 16);

  return (
    <div className="space-y-2" style={chatTypographyStyle} data-testid={`review-composer-${sampleId}`}>
      <div data-slot="chat-composer-anchor">
        <FileAttachmentPreview file={imageFile} status="done" onRemove={() => undefined} />
        <FileAttachmentPreview file={file} status="done" onRemove={() => undefined} />
        <ChatInputComposer presentation={presentation}>
          {running && <Button data-slot="chat-interrupt-button" variant="destructive-outline" size="icon" aria-label="Stop running conversation" onClick={() => setActionStatus("interrupted")} className="h-9 w-9 shrink-0 rounded-full sm:h-8 sm:w-8"><Square className="h-4 w-4 fill-current" aria-hidden="true" /></Button>}
          <PaperclipButton onClick={() => fileInputRef.current?.click()} />
          <ChatInputEditor
            ref={textareaRef}
            text={text}
            onChangeText={setText}
            onSend={() => { setText(""); setActionStatus("sent"); }}
            placeholder="메시지 입력"
            buttonLabel="보내기"
            modeIcon=""
            modeLabel=""
            borderColor=""
            buttonVariant="default"
            disabled={!text.trim()}
            textareaDisabled={false}
          />
        </ChatInputComposer>
        <input ref={fileInputRef} data-testid="review-file-picker" type="file" className="sr-only" onChange={(event) => setActionStatus(event.target.files?.[0]?.name ?? "")} />
      </div>
      <span data-testid="review-composer-action" aria-live="polite">{actionStatus}</span>
    </div>
  );
}

function ChatColumn({ presentation }: { presentation: "default" | "manuscript" }) {
  const { chatTypographyStyle } = useChatTypography();
  const column = (
    <div
      className={presentation === "manuscript" ? "w-full" : "w-full bg-background"}
      data-slot="chat-root"
      data-chat-presentation={presentation === "manuscript" ? "manuscript" : undefined}
      style={{ ...chatTypographyStyle, width: "100%" }}
    >
      <p className={presentation === "manuscript" ? "py-2 text-sm font-medium text-muted-foreground" : "px-3 py-2 text-sm font-medium text-muted-foreground"}>
        {presentation === "default" ? "기본 모양" : "원고형"}
      </p>
      <div className="overflow-y-auto py-2">
        {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            msg={msg}
            sessionId="components-review-pas"
            presentation={presentation}
          />
        ))}
      </div>
      <div className={presentation === "manuscript" ? "space-y-4 pb-3" : "space-y-4 px-3 pb-3"}>
        <ReviewComposer multiline={false} presentation={presentation} sampleId={`${presentation}-one-line`} />
        <ReviewComposer multiline presentation={presentation} sampleId={`${presentation}-multiline`} />
        <ReviewComposer multiline={false} presentation={presentation} running sampleId={`${presentation}-running`} />
      </div>
    </div>
  );
  return (
    presentation === "manuscript"
      ? <div className="w-full bg-[var(--persistent-session-paper)] p-5 lg:w-[568px] lg:p-6">{column}</div>
      : <div className="w-full max-w-[520px]">{column}</div>
  );
}

export function PersistentManuscriptChatReviewSample() {
  return (
    <div className="flex w-full flex-col items-center gap-4 overflow-x-hidden lg:flex-row lg:items-start lg:justify-center" data-testid="persistent-manuscript-chat-review">
      <ChatColumn presentation="default" />
      <ChatColumn presentation="manuscript" />
    </div>
  );
}
