"use client";

import { useId, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { MANUSCRIPT_ADJACENT_USER_ROW_CLASS_NAME } from "./ChatManuscriptList";
import { CollapsibleCaptionBody, CollapsibleCaptionHeader } from "./CollapsibleCaption";
import { InterventionMessage } from "./InterventionMessage";
import { UserMessage } from "./UserMessage";

export function ManuscriptAgentMessageGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ManuscriptAgentMessageGroupView
      messages={messages}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

/** Shared render surface lets the component review page show a real expanded sample. */
export function ManuscriptAgentMessageGroupView({
  messages,
  expanded,
  onToggle,
}: {
  messages: ChatMessage[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const firstMessage = messages[0];

  return (
    <div
      className="flex gap-2 py-1"
      data-slot="manuscript-agent-message-group"
      data-tree-node-id={firstMessage?.treeNodeId}
    >
      <span className="w-8 shrink-0" />
      <div className="min-w-0 flex flex-1 flex-col items-end">
        <CollapsibleCaptionHeader
          id={bodyId}
          expanded={expanded}
          title={`다른 세션 메시지 ${messages.length}건`}
          align="end"
          alignmentInset="content"
          onToggle={onToggle}
          className="w-full"
        />
        <CollapsibleCaptionBody id={bodyId} expanded={expanded} align="start" className="mt-0.5 w-full">
          <div data-slot="manuscript-agent-message-group-items">
            {messages.map((message, index) => (
              <div
                key={message.id}
                className={index === 0 ? "contents" : MANUSCRIPT_ADJACENT_USER_ROW_CLASS_NAME}
                data-slot="chat-manuscript-message"
                data-chat-presentation="manuscript"
              >
                {message.role === "user"
                  ? <UserMessage msg={message} presentation="manuscript" />
                  : <InterventionMessage msg={message} presentation="manuscript" />}
              </div>
            ))}
          </div>
        </CollapsibleCaptionBody>
      </div>
    </div>
  );
}
