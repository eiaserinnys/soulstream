import { Badge, useAgentPortraitUrlResolver } from "@seosoyoung/soul-ui";
import { StatusChip } from "../StatusChip";
import { AGENDA_KIND_LABEL, formatReturnTime, type Agenda, type AgendaKind } from "./pas-report-thread-model";
import type { PasReportThreadController } from "./use-pas-report-thread";

const KIND_TONE: Record<AgendaKind, string> = {
  question: "question", request: "question", review: "review", blocked: "blocked", running: "running", verifying: "awaiting_verification",
};

export function PasThreadRail({ controller }: { controller: PasReportThreadController }) {
  const { groups, processed, activeCardId, now } = controller;
  const sections = [
    { title: "결재 대기", items: groups.pending.map(agenda => ({ agenda, note: null as string | null })), always: true },
    { title: "진행 중", items: groups.running.map(agenda => ({ agenda, note: null as string | null })), always: true },
    { title: "미뤄 둠", items: groups.snoozed.map(agenda => ({ agenda, note: formatReturnTime(agenda.snoozedUntil!, now) })), always: false },
    { title: "처리됨", items: processed.map(item => ({ agenda: item.agenda, note: item.label })), always: false },
  ];
  return <aside className="pas-rt-rail" aria-label="안건 목록" data-testid="pas-rt-rail">
    <div className="pas-rt-rail-sections">
      {sections.filter(section => section.items.length || section.always).map(section =>
        <section key={section.title} aria-label={section.title}>
          <div className="pas-rt-rail-head"><h2>{section.title}</h2><span className="pas-rt-rail-count">{section.items.length}</span></div>
          <ul className="pas-rt-rail-list">
            {section.items.map(({ agenda, note }) => <RailRow key={agenda.cardId} agenda={agenda} note={note}
              section={section.title} active={agenda.cardId === activeCardId} onSelect={() => controller.select(agenda.cardId)} />)}
          </ul>
        </section>)}
    </div>
    <div className="pas-rt-rail-foot"><p className="pas-rt-hold-note">보류함 {groups.holdCount}개</p></div>
  </aside>;
}

function RailRow({ agenda, note, section, active, onSelect }: {
  agenda: Agenda; note: string | null; section: string; active: boolean; onSelect(): void;
}) {
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portrait = agenda.portraitUrl ?? (agenda.agentId ? resolvePortrait(agenda.agentId) : null);
  const kind = AGENDA_KIND_LABEL[agenda.kind];
  const number = agenda.number === null ? "" : `${agenda.number}번 `;
  return <li>
    <button type="button" className="pas-rt-rail-item" data-active={active || undefined} data-kind={agenda.kind} data-card-id={agenda.cardId}
      data-section={section} data-has-portrait={portrait ? "true" : undefined} aria-current={active ? "true" : undefined}
      aria-label={`${number}${agenda.title}, ${kind}${note ? `, ${note}` : ""}`} onClick={onSelect}>
      {agenda.number === null ? null : <span className="pas-rt-rail-number">#{agenda.number}</span>}
      <span className="pas-rt-rail-kind"><StatusChip label={kind} tone={KIND_TONE[agenda.kind]} /></span>
      {note ? <span className="pas-rt-rail-status">{section === "미뤄 둠" ? <Badge variant="info" size="sm">{note}</Badge> : <StatusChip label={note} tone="done" />}</span> : null}
      <span className="pas-rt-rail-title">{agenda.title}</span>
      {portrait ? <img className="pas-rt-rail-portrait" src={portrait} alt="" width={24} height={24} /> : null}
    </button>
  </li>;
}
