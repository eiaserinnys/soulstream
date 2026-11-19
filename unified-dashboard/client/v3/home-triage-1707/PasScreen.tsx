// PAS 서소영 화면. 홈 위에 얇은 한 줄 배너를 얹고, 캐릭터와 원고지 채팅을 세운다.
import { useEffect, useRef, useState } from "react";
import { Button, SwayCharacter } from "@seosoyoung/soul-ui";

import { StatusChip } from "../StatusChip";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import { pasMessages, pasSessionSummary, type SessionMessage } from "./triage-data";

export function PasScreen({ reviewCount, onGoHome }: { reviewCount: number; onGoHome(): void }) {
  const [messages, setMessages] = useState<SessionMessage[]>(() => [...pasMessages]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages(prev => [...prev, { id: `pas-${prev.length + 1}`, role: "user", text, time: "지금" }]);
    setDraft("");
  };

  return (
    <section className="v3-ht-pas" aria-label="PAS 서소영" data-testid="v3-ht-pas">
      <div className="v3-ht-pas-banner glass-strong glass-chrome lg-rim border border-glass-border">
        <p>확인하실 안건 {reviewCount}건이 홈 트리아지에 있습니다.</p>
        <Button variant="glass" size="sm" onClick={onGoHome} data-testid="v3-ht-pas-home">
          홈에서 넘겨 보기
        </Button>
      </div>
      <div className="v3-ht-pas-stage">
        <div className="v3-ht-pas-character" aria-hidden="true">
          <SwayCharacter
            width={300}
            height={420}
            shown
            motionEnabled
            active={draft.length === 0}
            assetBaseUrl="./characters/seosoyoung"
          />
        </div>
        <div className="v3-ht-pas-chat glass-strong glass-chrome lg-rim border border-glass-border">
          <header className="v3-ht-pas-chat-head">
            <strong>PAS 서소영</strong>
            <StatusChip label="상시 세션" tone="open" />
          </header>
          <div className="v3-ht-pas-messages" ref={scrollRef}>
            <ChatTranscript
              messages={messages}
              session={pasSessionSummary}
              testId="v3-ht-pas-transcript"
            />
          </div>
          <ChatComposer
            draft={draft}
            onDraft={setDraft}
            onSend={send}
            placeholder="서소영에게 말 걸기"
            inputLabel="PAS 서소영에게 말 걸기"
          />
        </div>
      </div>
    </section>
  );
}
