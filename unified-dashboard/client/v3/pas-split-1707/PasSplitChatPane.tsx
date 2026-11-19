import { useEffect, useMemo, useRef } from "react";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";

import type { ChatTurn } from "./pas-split-1707-data";

function toChatMessage(turn: ChatTurn): ChatMessage {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.text,
    treeNodeId: turn.id,
    treeNodeType: turn.role === "system" ? "system" : turn.role,
  } as ChatMessage;
}

export function PasSplitChatPane({ turns }: { turns: ChatTurn[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const { chatTypographyStyle } = useChatTypography();
  const messages = useMemo(() => turns.map(turn => ({ turn, message: toChatMessage(turn) })), [turns]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length]);

  return <>
    <header className="pas-chat-head">
      <img className="pas-chat-portrait" src="/api/nodes/eiaserinnys/agents/seosoyoung/portrait" alt="" width={44} height={44}/>
      <div className="pas-chat-title">
        <strong>서소영</strong>
        <span>PAS 지휘실 대화</span>
      </div>
      <span className="pas-chat-status"><i aria-hidden="true"/>연결됨</span>
    </header>
    <div className="pas-split-messages" data-testid="pas-chat-messages" role="log" aria-label="최근 대화"
      style={chatTypographyStyle}>
      {messages.map(({ turn, message }) => <div className="pas-split-message" data-role={turn.role} key={turn.id}>
        <span className="pas-split-message-role">
          {turn.role === "assistant" ? "서소영" : turn.role === "user" ? "나" : "기록"}
          <time>{turn.time}</time>
        </span>
        <ChatMessageItem msg={message} sessionId="pas-split-1707" presentation="manuscript"/>
        {turn.target ? <span className="pas-split-message-target">{turn.target}</span> : null}
      </div>)}
      <div ref={endRef} aria-hidden="true"/>
    </div>
  </>;
}
