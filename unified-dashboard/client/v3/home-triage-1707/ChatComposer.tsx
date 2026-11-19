// 입력창. 운영 정본 ChatInputComposer 와 ChatInputEditor 를 쓰고,
// 시안의 저장 없는 전송만 바깥에서 받는다. Enter 전송과 한글 조합 가드를 유지한다.
import { useRef, type RefObject } from "react";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";

export function ChatComposer({
  draft,
  onDraft,
  onSend,
  placeholder,
  inputLabel,
  composerRef,
}: {
  draft: string;
  onDraft(value: string): void;
  onSend(): void;
  placeholder: string;
  inputLabel: string;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const composingRef = useRef(false);

  return (
    <form
      className="v3-ht-composer"
      onSubmit={event => {
        event.preventDefault();
        onSend();
      }}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={event => {
        if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
        if (!(event.target instanceof HTMLTextAreaElement)) return;
        if (event.nativeEvent.isComposing || composingRef.current) return;
        event.preventDefault();
        onSend();
      }}
    >
      <ChatInputComposer>
        <ChatInputEditor
          ref={composerRef}
          text={draft}
          onChangeText={onDraft}
          onSend={onSend}
          placeholder={placeholder}
          inputLabel={inputLabel}
          buttonLabel="보내기"
          modeIcon=""
          modeLabel=""
          borderColor=""
          buttonVariant="default"
          disabled={draft.trim().length === 0}
          textareaDisabled={false}
        />
      </ChatInputComposer>
    </form>
  );
}
