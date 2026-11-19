import { useEffect, useRef, useState } from "react";
import { Button, ChatInput, SwayCharacter } from "@seosoyoung/soul-ui";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { GlassPanel } from "./GlassPanel";
import { StatusChip } from "../StatusChip";
import { PAS_MESSAGES } from "./approval-desk-data";

const PAS_CHAT_MESSAGES: ChatMessage[] = PAS_MESSAGES.map((message, index) => ({
  id: `pas-message-${index}`,
  role: message.role,
  content: message.text,
  treeNodeId: `pas-message-${index}`,
  treeNodeType: message.role === "user" ? "user_message" : "assistant_message",
}));

/** 평소 PAS 화면. 캐릭터 옆 한 줄 브리핑 캡슐이 결재 데스크로 잇는다. */
export function PasBriefingScreen({ deskCount, onOpenDesk }: { deskCount: number; onOpenDesk(): void }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = slotRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div className="ad1707-screen ad1707-pas" data-screen="pas">
    <div className="ad1707-pas-stage">
      <div className="ad1707-pas-character">
        <div ref={slotRef} className="ad1707-pas-character-slot">
          {size.width > 0 && size.height > 0 ? <SwayCharacter shown width={size.width} height={size.height}
            motionEnabled active assetBaseUrl="/characters/seosoyoung" /> : null}
        </div>
        <div className="ad1707-briefing-capsule glass-strong glass-chrome lg-rim" role="status">
          <span>{deskCount > 0 ? `결재 서류 ${deskCount}건 대기 중` : "오늘 결재할 서류 없음"}</span>
          <Button variant="glass" size="sm" onClick={onOpenDesk}>결재 데스크 열기</Button>
        </div>
      </div>

      <GlassPanel as="section" className="ad1707-manuscript" data-slot="chat-root"
        data-chat-presentation="manuscript" aria-label="서소영 대화">
        <header className="ad1707-manuscript-head">
          <strong>서소영</strong>
          <StatusChip label="PAS" tone="running" />
        </header>
        <div className="ad1707-manuscript-body">
          {PAS_CHAT_MESSAGES.map(message => <ChatMessageItem key={message.id} msg={message}
            sessionId="mock-pas-seosoyoung" presentation="manuscript" />)}
        </div>
        <div className="ad1707-manuscript-composer">
          <ChatInput presentation="manuscript" />
        </div>
      </GlassPanel>
    </div>
  </div>;
}
