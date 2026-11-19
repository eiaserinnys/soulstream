import { useEffect, useRef } from "react";
import { DashboardIconCap, ProfileAvatar } from "@seosoyoung/soul-ui";
import { X } from "lucide-react";
import { StatusChip } from "../StatusChip";
import type { SessionMessage } from "./approval-desk-data";

export interface OverlayDetail {
  number: number;
  title: string;
  folder: string;
  statusLabel: string;
  statusTone: string;
  request: string;
  checks?: { title: string; result: string }[];
  assignee: { name: string; role: string; session: string };
  messages: SessionMessage[];
}

/** 카드 상세와 세션 대화를 한 창에서 두 열로 보여 준다. */
export function CardSessionOverlay({ detail, onClose }: { detail: OverlayDetail | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (detail && !dialog.open) dialog.showModal();
    if (!detail && dialog.open) dialog.close();
  }, [detail]);
  return <dialog ref={ref} className="ad1707-card-dialog glass-strong glass-chrome lg-rim"
    aria-label={detail ? `카드 ${detail.number} 상세와 세션` : "카드 상세와 세션"}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    {detail ? <div className="ad1707-card-dialog-body">
      <header className="ad1707-dialog-head">
        <div className="ad1707-dialog-title">
          <StatusChip label={detail.statusLabel} tone={detail.statusTone} />
          <h2>#{detail.number} {detail.title}</h2>
          <p>{detail.folder}</p>
        </div>
        <DashboardIconCap label="카드 상세 닫기" onClick={onClose}><X className="size-5" strokeWidth={1.4} absoluteStrokeWidth /></DashboardIconCap>
      </header>

      <div className="ad1707-card-dialog-grid">
        <section className="ad1707-overlay-card" aria-label="카드 내용">
          <h3 className="ad1707-block-title">원 요청</h3>
          <p className="ad1707-body-copy">{detail.request}</p>
          {detail.checks?.length ? <>
            <h3 className="ad1707-block-title ad1707-overlay-checks-title">확인 항목</h3>
            <ol className="ad1707-overlay-checks">
              {detail.checks.map((check, index) => <li key={check.title}>
                <strong>{index + 1}. {check.title}</strong>
                <p>{check.result}</p>
              </li>)}
            </ol>
          </> : null}
          <div className="ad1707-assignee ad1707-overlay-assignee">
            <ProfileAvatar role="assistant" hasPortrait portraitUrl="/api/nodes/eiaserinnys/agents/roselin/portrait" fallbackEmoji="🤖" />
            <div className="ad1707-assignee-copy">
              <strong>{detail.assignee.name}</strong>
              <span>{detail.assignee.role}</span>
              <span>{detail.assignee.session}</span>
            </div>
          </div>
        </section>

        <section className="ad1707-overlay-session" aria-label="세션 대화">
          <h3 className="ad1707-block-title">세션 대화</h3>
          <div className="ad1707-overlay-messages">
            {detail.messages.map((message, index) => <article key={`${message.time}-${index}`} className="ad1707-overlay-message"
              data-role={message.role}>
              <ProfileAvatar role={message.role === "user" ? "user" : "assistant"}
                hasPortrait={message.role === "assistant"}
                portraitUrl={message.role === "assistant" ? "/api/nodes/eiaserinnys/agents/roselin/portrait" : undefined}
                fallbackEmoji={message.role === "user" ? "🙂" : "🤖"} />
              <div className="ad1707-overlay-message-copy">
                <span className="ad1707-overlay-message-meta">{message.role === "user" ? "디렉터" : "에이전트"}<time>{message.time}</time></span>
                <p>{message.text}</p>
              </div>
            </article>)}
          </div>
        </section>
      </div>
    </div> : null}
  </dialog>;
}
