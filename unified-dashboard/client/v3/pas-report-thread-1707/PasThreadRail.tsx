import { Badge } from "@seosoyoung/soul-ui";
import { StatusChip } from "../StatusChip";
import { AGENDA_KIND_LABEL, INITIAL_HOLD_COUNT, agendaStatusLabel, agendaStatusTone, agentPortraitUrl, type Agenda } from "./pas-report-thread-1707-data";

export function PasThreadRail({ agendas, activeId, onSelect }: {
  agendas: readonly Agenda[];
  activeId: string;
  onSelect(id: string): void;
}) {
  const sections = [
    { title: "결재 대기", items: agendas.filter((item) => item.status === "review" && !item.snoozedLabel) },
    { title: "진행 중", items: agendas.filter((item) => item.status === "running" && !item.snoozedLabel) },
    { title: "미뤄 둠", items: agendas.filter((item) => item.snoozedLabel) },
    { title: "처리됨", items: agendas.filter((item) => item.status !== "review" && item.status !== "running" && !item.snoozedLabel) },
  ];
  return <aside className="pas-rt1707-rail" aria-label="안건 목록">
    <div className="pas-rt1707-rail-sections">
      {sections.filter((section) => section.items.length || section.title === "결재 대기" || section.title === "진행 중").map((section) =>
        <section key={section.title} aria-label={section.title}>
          <div className="pas-rt1707-rail-head"><h2>{section.title}</h2><span className="pas-rt1707-rail-count">{section.items.length}</span></div>
          <ul className="pas-rt1707-rail-list">
            {section.items.map((agenda) => <li key={agenda.id}>
              <button type="button" className="pas-rt1707-rail-item" data-active={agenda.id === activeId || undefined}
                data-status={agenda.status} aria-current={agenda.id === activeId ? "true" : undefined}
                aria-label={`${agenda.number}번 ${agenda.title}, ${agendaStatusLabel(agenda)}`}
                onClick={() => onSelect(agenda.id)}>
                <span className="pas-rt1707-rail-number">#{agenda.number}</span>
                <span className="pas-rt1707-rail-kind">{AGENDA_KIND_LABEL[agenda.kind]}</span>
                <span className="pas-rt1707-rail-title">{agenda.title}</span>
                {agenda.status !== "review" || agenda.keptAsReference || agenda.snoozedLabel ? <span className="pas-rt1707-rail-status">
                  {agenda.snoozedLabel ? <Badge variant="info" size="sm">{agenda.snoozedLabel}</Badge> : agenda.status !== "review" ? <StatusChip label={agendaStatusLabel(agenda)} tone={agendaStatusTone(agenda)} /> : null}
                  {agenda.keptAsReference ? <Badge variant="info" size="sm">참고</Badge> : null}
                </span> : null}
                <img className="pas-rt1707-rail-portrait" src={agentPortraitUrl(agenda.agent)} alt="" width={24} height={24} />
              </button>
            </li>)}
          </ul>
        </section>)}
    </div>
    <div className="pas-rt1707-rail-foot"><p className="pas-rt1707-hold-note">보류함 {INITIAL_HOLD_COUNT}개 (변동 없음)</p></div>
  </aside>;
}
