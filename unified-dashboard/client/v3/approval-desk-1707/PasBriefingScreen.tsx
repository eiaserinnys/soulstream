import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, SwayCharacter } from "@seosoyoung/soul-ui";
import { GlassPanel } from "./GlassPanel";
import { StatusChip } from "../StatusChip";
import { PAS_MESSAGES, type SessionMessage } from "./approval-desk-data";

/** 평소 PAS 화면. 캐릭터 옆 한 줄 브리핑 캡슐이 결재 데스크로 잇는다. */
export function PasBriefingScreen({ deskCount, onOpenDesk }: { deskCount: number; onOpenDesk(): void }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [messages, setMessages] = useState<SessionMessage[]>(PAS_MESSAGES);
  const [draft, setDraft] = useState("");

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

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages(current => [...current, { role: "user", text, time: "지금" }]);
    setDraft("");
  };

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

      <GlassPanel as="section" className="ad1707-manuscript" aria-label="서소영 대화">
        <header className="ad1707-manuscript-head">
          <strong>서소영</strong>
          <StatusChip label="PAS" tone="running" />
        </header>
        <div className="ad1707-manuscript-body">
          {messages.map((message, index) => <article key={`${message.time}-${index}`} className="ad1707-manuscript-message" data-role={message.role}>
            <span className="ad1707-manuscript-meta">{message.role === "user" ? "디렉터" : "서소영"}<time>{message.time}</time></span>
            <p>{message.text}</p>
          </article>)}
        </div>
        <form className="ad1707-manuscript-composer" onSubmit={send}>
          <label className="ad1707-sr-only" htmlFor="ad1707-pas-draft">서소영에게 보낼 말</label>
          <textarea id="ad1707-pas-draft" rows={1} value={draft} placeholder="서소영에게 말하기"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} />
          <Button type="submit" size="sm" disabled={!draft.trim()}>보내기</Button>
        </form>
      </GlassPanel>
    </div>
  </div>;
}
