// 오른쪽 담당 세션 패널. 고른 카드의 담당 세션으로 저절로 바뀌고, 최근 실행과 세션 기록,
// 마지막 완료 보고를 보여 준다. 아래 입력창으로 이어서 지시를 보낸다.
import { useEffect, useRef, type RefObject } from "react";
import { Button, ProfileAvatar } from "@seosoyoung/soul-ui";

import { StatusChip } from "../StatusChip";
import type { SessionMessage, TriageCard } from "./triage-data";

export function AssigneeSessionPanel({
  card,
  messages,
  draft,
  onDraft,
  onSend,
  composerRef,
  onOpenCard,
}: {
  card: TriageCard | null;
  messages: SessionMessage[];
  draft: string;
  onDraft(value: string): void;
  onSend(): void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onOpenCard(): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, card?.id]);

  const lastAgentId = [...messages].reverse().find(message => message.role === "agent")?.id ?? null;
  const finalReport = card?.kind === "검수 대기";

  return (
    <aside
      className="v3-ht-pane v3-ht-session glass-strong glass-chrome lg-rim border border-glass-border"
      aria-label="담당 세션"
      data-testid="v3-ht-session"
    >
      {card ? (
        <>
          <header className="v3-ht-session-head">
            <ProfileAvatar
              role="assistant"
              shape="circle"
              hasPortrait
              portraitUrl={card.session.portraitUrl}
              fallbackEmoji={card.session.emoji}
            />
            <div className="v3-ht-session-id">
              <strong>{card.session.agentName}</strong>
              <span>{card.session.preset}, {card.session.node}</span>
            </div>
            <StatusChip label={card.session.statusLabel} tone={card.session.status} />
          </header>
          <div className="v3-ht-session-scroll" ref={scrollRef}>
            <button type="button" className="v3-ht-session-card" onClick={onOpenCard}>
              <span className="v3-ht-row-number">#{card.number}</span>
              <span className="v3-ht-session-card-title">{card.title}</span>
            </button>
            <section className="v3-ht-session-section">
              <h3 className="v3-ht-session-label">최근 실행</h3>
              <ol className="v3-ht-timeline">
                {card.session.timeline.map((step, index) => (
                  <li key={`${step.time}-${index}`} className="v3-ht-timeline-step" data-state={step.state}>
                    <span className="v3-ht-timeline-dot" aria-hidden="true" />
                    <span className="v3-ht-timeline-time">{step.time}</span>
                    <span className="v3-ht-timeline-label">{step.label}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="v3-ht-session-section" aria-label="세션 기록">
              <h3 className="v3-ht-session-label">세션 기록</h3>
              <div className="v3-ht-messages">
                {messages.map(message => (
                  <article key={message.id} className={`v3-ht-message v3-ht-message--${message.role}`}>
                    <header>
                      <strong>{message.role === "agent" ? card.session.agentName : "서소영"}</strong>
                      {finalReport && message.id === lastAgentId ? <span className="v3-ht-report-tag">완료 보고</span> : null}
                      <time>{message.time}</time>
                    </header>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
            </section>
          </div>
          <form
            className="v3-ht-composer"
            onSubmit={event => {
              event.preventDefault();
              onSend();
            }}
          >
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              placeholder="이 세션에 이어서 지시하기"
              aria-label="담당 세션에 이어서 지시하기"
              onChange={event => onDraft(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={event => {
                if (event.key !== "Enter" || event.shiftKey) return;
                if (event.nativeEvent.isComposing || composingRef.current) return;
                event.preventDefault();
                onSend();
              }}
            />
            <Button type="submit" size="sm" disabled={draft.trim().length === 0}>보내기</Button>
          </form>
        </>
      ) : (
        <div className="v3-ht-session-empty">
          <p>확인할 카드를 고르면 담당 세션이 여기에 뜹니다.</p>
        </div>
      )}
    </aside>
  );
}
