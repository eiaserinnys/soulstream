import type { RefObject } from "react";
import { Button, Checkbox, DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, Maximize2, Stamp } from "lucide-react";

import { EvidenceArt } from "./EvidenceArt";
import type { Agenda } from "./pas-split-1707-data";

export function PasSplitClipboard({
  agenda, pending, checked, onSelect, onMove, onToggleCheck, onInstruct, onAnswer, onEvidence, onPrimary, evidenceTriggerRef,
}: {
  agenda: Agenda | null;
  pending: Agenda[];
  checked: Record<string, boolean>;
  onSelect(agendaId: string): void;
  onMove(delta: number): void;
  onToggleCheck(agendaId: string, checkId: string): void;
  onInstruct(agenda: Agenda, label: string): void;
  onAnswer(agenda: Agenda, option: string): void;
  onEvidence(agendaId: string): void;
  onPrimary(agenda: Agenda): void;
  evidenceTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const index = agenda ? pending.findIndex(item => item.id === agenda.id) : -1;

  return <div className="pas-clipboard-paper" data-testid="pas-clipboard">
    <div className="pas-clipboard-index" role="tablist" aria-label="결재 서류 색인">
      <DashboardIconCap appearance="bare" size="small" label="이전 서류" onClick={() => onMove(-1)}>
        <ChevronLeft className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
      </DashboardIconCap>
      <div className="pas-clipboard-tabs">
        {pending.map(item => <button key={item.id} type="button" role="tab" className="pas-clipboard-tab"
          data-active={agenda?.id === item.id || undefined} aria-selected={agenda?.id === item.id}
          onClick={() => onSelect(item.id)}>
          <span className="pas-clipboard-tab-number">#{item.number}</span>
          <span className="pas-clipboard-tab-kind">{item.kind}</span>
        </button>)}
      </div>
      <DashboardIconCap appearance="bare" size="small" label="다음 서류" onClick={() => onMove(1)}>
        <ChevronRight className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
      </DashboardIconCap>
    </div>

    {agenda ? <article className="pas-clipboard-sheet" aria-labelledby="pas-sheet-title">
      <header className="pas-sheet-head">
        <span className="pas-sheet-kind">{agenda.kind}</span>
        <h2 id="pas-sheet-title">#{agenda.number} {agenda.title}</h2>
        <p className="pas-sheet-meta">{agenda.requester}, {agenda.requestedAt}</p>
      </header>

      <p className="pas-sheet-excerpt">{agenda.excerpt}</p>

      <section className="pas-sheet-section" aria-label="확인 항목">
        <h3>확인 항목</h3>
        <ul className="pas-check-list">
          {agenda.checks.map((check, checkIndex) => {
            const key = `${agenda.id}:${check.id}`;
            const done = Boolean(checked[key]);
            return <li className="pas-check-row" key={check.id} data-done={done || undefined}>
              <label className="pas-check-label">
                <Checkbox variant="card-item" aria-label={check.label} checked={done}
                  onCheckedChange={() => onToggleCheck(agenda.id, check.id)}/>
                <span className="pas-check-text">{check.label}</span>
              </label>
              <Button variant="ghost" size="sm" className="pas-check-instruct"
                onClick={() => onInstruct(agenda, `#${agenda.number} ${checkIndex + 1}번 항목 보완 지시`)}>
                구두 지시
              </Button>
            </li>;
          })}
        </ul>
      </section>

      <section className="pas-sheet-section" aria-label="시각 증거">
        <h3>시각 증거</h3>
        <button ref={evidenceTriggerRef} type="button" className="pas-evidence-trigger"
          onClick={() => onEvidence(agenda.id)} aria-label={`${agenda.evidence.label} 확대해서 보기`}>
          <span className="pas-evidence-art"><EvidenceArt kind={agenda.evidence.kind}/></span>
          <span className="pas-evidence-caption">
            <span>{agenda.evidence.label}</span>
            <Maximize2 className="size-4" aria-hidden="true"/>
          </span>
        </button>
      </section>

      <footer className="pas-sheet-actions">
        {agenda.question ? <>
          <span className="pas-question-label">{agenda.question.label}</span>
          <div className="pas-question-options" role="group" aria-label="응답 선택">
            {agenda.question.options.map(option => <Button key={option.label}
              variant={option.recommended ? "default" : "outline"} size="sm"
              data-question-option={option.label}
              onClick={() => onAnswer(agenda, option.label)}>
              {option.label}{option.recommended ? " (권함)" : ""}
            </Button>)}
          </div>
          <span className="pas-sheet-spacer"/>
          <Button variant="ghost" size="sm" onClick={() => onInstruct(agenda, `#${agenda.number} 되묻기`)}>되묻기</Button>
          <Button variant="outline" size="sm" onClick={() => onInstruct(agenda, `#${agenda.number} 자유 응답`)}>자유 응답</Button>
        </> : <>
          <span className="pas-sheet-counter">{index + 1} / {pending.length}</span>
          <span className="pas-sheet-spacer"/>
          {agenda.primary ? <Button variant="default" size="default" onClick={() => onPrimary(agenda)}>
            <Stamp className="size-4" aria-hidden="true"/>{agenda.primary.label}
          </Button> : null}
        </>}
      </footer>
    </article> : <p className="pas-clipboard-empty">미결재 서류가 없습니다.</p>}
  </div>;
}
