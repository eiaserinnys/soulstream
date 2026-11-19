import { useEffect, useRef } from "react";
import { MarkdownContent } from "@seosoyoung/soul-ui";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";

import type { ChatTurn } from "./pas-split-1707-data";

export function PasSplitChatPane({ turns }: { turns: ChatTurn[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const { chatTypographyStyle } = useChatTypography();

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);

  return <>
    <header className="pas-chat-head">
      <img className="pas-chat-portrait" src="/system-portrait.png" alt="" width={44} height={44}/>
      <div className="pas-chat-title">
        <strong>서소영</strong>
        <span>PAS 지휘실 대화</span>
      </div>
      <span className="pas-chat-status"><i aria-hidden="true"/>연결됨</span>
    </header>
    <div className="pas-split-messages" data-testid="pas-chat-messages" role="log" aria-label="최근 대화"
      style={chatTypographyStyle}>
      {turns.map(turn => <div className="pas-split-message" data-role={turn.role} key={turn.id}>
        <span className="pas-split-message-role">
          {turn.role === "assistant" ? "서소영" : turn.role === "user" ? "나" : "기록"}
          <time>{turn.time}</time>
        </span>
        {turn.role === "system"
          ? <p className="pas-split-message-body">{turn.text}</p>
          : <div className="pas-split-message-body"><MarkdownContent content={turn.text}/></div>}
        {turn.target ? <span className="pas-split-message-target">{turn.target}</span> : null}
      </div>)}
      <div ref={endRef} aria-hidden="true"/>
    </div>
  </>;
}
