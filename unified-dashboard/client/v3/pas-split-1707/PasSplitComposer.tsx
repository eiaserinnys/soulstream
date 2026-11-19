import { useRef, type KeyboardEvent, type RefObject } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatSendButton } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { X } from "lucide-react";

export function PasSplitComposer({
  target, value, inputRef, onChange, onSend, onClearTarget,
}: {
  target: { agendaId: string; label: string } | null;
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange(value: string): void;
  onSend(): void;
  onClearTarget(): void;
}) {
  const composingRef = useRef(false);
  const { chatTypographyStyle } = useChatTypography();

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onSend();
  };

  return <div className="pas-split-composer" data-testid="pas-composer" style={chatTypographyStyle}>
    {target ? <div className="pas-split-target" role="status" data-testid="pas-instruction-target">
      <span className="pas-split-target-label">{target.label}</span>
      <DashboardIconCap appearance="bare" size="small" label="전달 대상 해제" onClick={onClearTarget}>
        <X className="size-4" aria-hidden="true"/>
      </DashboardIconCap>
    </div> : null}
    <ChatInputComposer presentation="manuscript">
      <div data-slot="chat-input-editor" className="pas-split-editor">
        <textarea
          ref={inputRef}
          data-slot="chat-input-body"
          className="pas-split-input"
          aria-label="PAS 메시지"
          placeholder={target ? "지시할 내용을 입력하세요" : "서소영에게 메시지"}
          rows={1}
          value={value}
          onChange={event => onChange(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
        />
      </div>
      <ChatSendButton presentation="manuscript" onSend={onSend} disabled={!value.trim()} label="보내기"/>
    </ChatInputComposer>
  </div>;
}
