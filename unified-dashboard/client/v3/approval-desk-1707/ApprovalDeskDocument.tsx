import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ProfileAvatar } from "@seosoyoung/soul-ui";
import { ExternalLink, FileText, Paperclip } from "lucide-react";
import { StatusChip } from "../StatusChip";
import { GlassPanel } from "./GlassPanel";
import { EvidenceArt } from "./EvidenceArt";
import type { EvidenceSpec, PendingDoc } from "./approval-desk-data";

const TONE = { question: "question", task: "running", review: "review" } as const;

export function ApprovalDeskDocument({ doc, onOpenEvidence, onSupplement, onAnswer }: {
  doc: PendingDoc;
  onOpenEvidence(evidence: EvidenceSpec, trigger: HTMLButtonElement): void;
  onSupplement(doc: PendingDoc, note: string): void;
  onAnswer(doc: PendingDoc, option: string): void;
}) {
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setOpenItem(null);
    setNote("");
  }, [doc.id]);
  useEffect(() => {
    if (openItem !== null) inputRef.current?.focus();
  }, [openItem]);

  const submitNote = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    if (!trimmed) return;
    onSupplement(doc, trimmed);
    setOpenItem(null);
    setNote("");
  };

  return <div className="ad1707-doc-seat">
    <div className="ad1707-paper-stack" aria-hidden="true"><span /><span /></div>
    <GlassPanel as="article" webgl className="ad1707-doc" aria-labelledby="ad1707-doc-title">
      <header className="ad1707-doc-head">
        <div className="ad1707-doc-meta">
          <StatusChip label={doc.kindLabel} tone={TONE[doc.kind]} />
          {doc.subLabel ? <span className="ad1707-doc-sub">{doc.subLabel}</span> : null}
          <span>{doc.folder}</span>
          <span>{doc.age}</span>
        </div>
        <h1 id="ad1707-doc-title" className="ad1707-doc-title">{doc.title}</h1>
      </header>

      <div className="ad1707-doc-grid">
        <div className="ad1707-doc-main">
          <section className="ad1707-request" aria-label="원 요청">
            <h2 className="ad1707-block-title">원 요청</h2>
            <p>{doc.request}</p>
          </section>

          {doc.kind === "question" && doc.options ? <section className="ad1707-section" aria-label="선택지">
            <h2 className="ad1707-block-title">배경</h2>
            <p className="ad1707-body-copy">{doc.background}</p>
            <div className="ad1707-options">
              {doc.options.map(option => <Button key={option.label} variant="choice" className="ad1707-option"
                onClick={() => onAnswer(doc, option.label)}>
                <span className="ad1707-option-head">
                  <strong>{option.label}</strong>
                  {option.recommended ? <StatusChip label="권함" tone="done" /> : null}
                </span>
                <span className="ad1707-option-desc">{option.description}</span>
              </Button>)}
            </div>
          </section> : null}

          {doc.kind === "task" && doc.steps ? <section className="ad1707-section" aria-label="실행 단계">
            <h2 className="ad1707-block-title">실행 단계</h2>
            <ol className="ad1707-steps">
              {doc.steps.map((step, index) => <li key={step.title}>
                <span className="ad1707-step-number" aria-hidden="true">{index + 1}</span>
                <div><strong>{step.title}</strong><p>{step.detail}</p></div>
              </li>)}
            </ol>
          </section> : null}

          {doc.kind === "review" && doc.checks ? <section className="ad1707-section" aria-label="확인 항목">
            <h2 className="ad1707-block-title">확인 항목</h2>
            <ol className="ad1707-checks">
              {doc.checks.map(item => <li key={item.id} className="ad1707-check" data-check-item={item.id}>
                <div className="ad1707-check-head">
                  <strong>{item.id}. {item.title}</strong>
                  <Button size="xs" variant="ghost" className="ad1707-flag-button"
                    aria-expanded={openItem === item.id}
                    onClick={() => { setOpenItem(value => value === item.id ? null : item.id); setNote(""); }}>
                    지적
                  </Button>
                </div>
                <p className="ad1707-check-result">{item.result}</p>
                {item.caveat ? <p className="ad1707-check-caveat">미확인: {item.caveat}</p> : null}
                {openItem === item.id ? <form className="ad1707-inline-fix" onSubmit={submitNote}>
                  <label className="ad1707-sr-only" htmlFor={`ad1707-fix-${doc.id}-${item.id}`}>{item.title} 보완 지시</label>
                  <textarea id={`ad1707-fix-${doc.id}-${item.id}`} ref={inputRef} rows={2} value={note}
                    placeholder="이 항목에서 고칠 점을 적어 주세요."
                    onChange={event => setNote(event.target.value)}
                    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setOpenItem(null); } }} />
                  <div className="ad1707-inline-fix-actions">
                    <Button size="xs" variant="ghost" type="button" onClick={() => setOpenItem(null)}>취소</Button>
                    <Button size="xs" type="submit" disabled={!note.trim()}>보완 지시 보내기</Button>
                  </div>
                </form> : null}
              </li>)}
            </ol>
            {doc.unverified ? <p className="ad1707-unverified"><strong>미확인 범위</strong> {doc.unverified}</p> : null}
          </section> : null}
        </div>

        <aside className="ad1707-doc-side" aria-label="증거와 담당">
          <div className="ad1707-side-head">
            <h2 className="ad1707-block-title">첨부 증거</h2>
            <Paperclip className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="ad1707-evidence-list">
            {doc.evidence.map(evidence => <button key={evidence.id} type="button" className="ad1707-evidence"
              onClick={event => onOpenEvidence(evidence, event.currentTarget)} aria-label={`${evidence.caption} 확대해서 보기`}>
              <span className="ad1707-evidence-frame"><EvidenceArt id={evidence.id} /></span>
              <span className="ad1707-evidence-caption">{evidence.caption}</span>
              <span className="ad1707-evidence-note">{evidence.note}</span>
            </button>)}
          </div>

          {doc.document ? <button type="button" className="ad1707-link-card" aria-label={`${doc.document.title} 발행 문서 열기`}>
            <FileText className="size-5" strokeWidth={1.5} aria-hidden="true" />
            <span className="ad1707-link-copy">
              <strong>{doc.document.title}</strong>
              <span>{doc.document.path}</span>
            </span>
            <ExternalLink className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </button> : null}

          <div className="ad1707-assignee">
            <ProfileAvatar role="assistant" hasPortrait portraitUrl="/api/nodes/eiaserinnys/agents/roselin/portrait"
              fallbackEmoji="🤖" />
            <div className="ad1707-assignee-copy">
              <strong>{doc.assignee.name}</strong>
              <span>{doc.assignee.role}</span>
              <span>{doc.assignee.session}</span>
            </div>
          </div>
        </aside>
      </div>
    </GlassPanel>
  </div>;
}
