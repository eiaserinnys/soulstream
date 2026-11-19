import { StatusChip } from "../StatusChip";
import {
  AGENDA_KIND_LABEL,
  AGENDA_STATUS_LABEL,
  INITIAL_HOLD_COUNT,
  agentPortraitUrl,
  type Agenda,
} from "./pas-report-thread-1707-data";

export function PasThreadRail({ agendas, activeId, onSelect }: {
  agendas: readonly Agenda[];
  activeId: string;
  onSelect(id: string): void;
}) {
  const pending = agendas.filter((agenda) => agenda.status === "review").length;
  return <aside className="pas-rt1707-rail" aria-label="결재할 안건">
    <div className="pas-rt1707-rail-head">
      <h2>결재 대기</h2>
      <span className="pas-rt1707-rail-count" aria-label={`${pending}건`}>{pending}</span>
    </div>
    <ul className="pas-rt1707-rail-list">
      {agendas.map((agenda) => <li key={agenda.id}>
        <button type="button" className="pas-rt1707-rail-item" data-active={agenda.id === activeId || undefined}
          data-status={agenda.status} aria-current={agenda.id === activeId ? "true" : undefined}
          aria-label={`${agenda.number}번 ${agenda.title}, ${AGENDA_STATUS_LABEL[agenda.status]}`}
          onClick={() => onSelect(agenda.id)}>
          <span className="pas-rt1707-rail-number">#{agenda.number}</span>
          <span className="pas-rt1707-rail-kind">{AGENDA_KIND_LABEL[agenda.kind]}</span>
          <span className="pas-rt1707-rail-title">{agenda.title}</span>
          <span className="pas-rt1707-rail-status"><StatusChip label={AGENDA_STATUS_LABEL[agenda.status]} tone={agenda.status} /></span>
          <img className="pas-rt1707-rail-portrait" src={agentPortraitUrl(agenda.agent)} alt="" width={24} height={24} />
          <span className="pas-rt1707-rail-dot" aria-hidden="true" />
        </button>
      </li>)}
    </ul>
    <div className="pas-rt1707-rail-foot">
      <p className="pas-rt1707-hold-note">보류함 {INITIAL_HOLD_COUNT}개 (변동 없음)</p>
    </div>
  </aside>;
}
