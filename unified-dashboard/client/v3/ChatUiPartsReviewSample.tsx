import { useMemo, useRef, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { FileAttachmentPreview } from "@seosoyoung/soul-ui/components/FileAttachmentPreview";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";
import { SourceLink } from "@seosoyoung/soul-ui/components/SourceLink";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { ChatInputAccessories } from "@seosoyoung/soul-ui/components/chat/ChatInputAccessories";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "assistant",
    treeNodeId: id,
    treeNodeType: "assistant_message",
    content,
  } as ChatMessage;
}

const SOURCE_URL = "https://example.com/reference";

function StructuredReply() {
  return (
    <div className="space-y-2">
      <p>구조화 응답은 메시지에서 쓸 수 있는 폭을 채웁니다.</p>
      <p><SourceLink href={SOURCE_URL}>출처 링크</SourceLink></p>
      <MarkdownContent
        content="[마크다운 출처 링크](https://example.com/reference)"
        sourceLinkComponent={SourceLink}
      />
    </div>
  );
}

export function ChatUiMessageReviewSample() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <AssistantMessage
          msg={assistantMessage("chat-ui-text", "일반 채팅의 기존 말풍선 폭입니다.")}
          contentLayout="text"
        />
        <AssistantMessage
          msg={assistantMessage("chat-ui-structured", "")}
          contentLayout="structured"
        >
          <StructuredReply />
        </AssistantMessage>
      </div>
      <div className="space-y-2">
        <AssistantMessage
          msg={assistantMessage("chat-ui-pas-text", "PAS 원고형의 기존 폭입니다.")}
          presentation="manuscript"
          contentLayout="text"
        />
        <AssistantMessage
          msg={assistantMessage("chat-ui-pas-structured", "")}
          presentation="manuscript"
          contentLayout="structured"
        >
          <StructuredReply />
        </AssistantMessage>
      </div>
    </div>
  );
}

export function ChatInputAccessoriesReviewSample() {
  const [draft, setDraft] = useState("기존 채팅 초안");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const file = useMemo(
    () => new File(["검수 샘플"], "very-long-attachment-name-for-narrow-screen.pdf", { type: "application/pdf" }),
    [],
  );
  const attachments = (
    <div className="flex min-w-0 gap-2 overflow-x-auto pb-2">
      <FileAttachmentPreview file={file} status="done" onRemove={() => {}} />
    </div>
  );
  const undoButton = (
    <Button variant="outline" type="button">
      되돌리기
    </Button>
  );

  return (
    <div className="w-full min-w-0 space-y-2">
      <ChatInputAccessories attachments={attachments} action={undoButton} />
      <ChatInputAccessories action={undoButton} />
      <ChatInputComposer>
        <ChatInputEditor
          ref={editorRef}
          inputLabel="기존 채팅 초안"
          text={draft}
          onChangeText={setDraft}
          onSend={() => {}}
          placeholder="메시지 입력"
          buttonLabel="메시지 보내기"
          modeIcon=""
          modeLabel=""
          borderColor=""
          buttonVariant="default"
          disabled={false}
          textareaDisabled={false}
        />
      </ChatInputComposer>
    </div>
  );
}
