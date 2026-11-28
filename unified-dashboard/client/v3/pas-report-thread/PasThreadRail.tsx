import { useTranslation } from "react-i18next";
import { Badge, Button, StatusChip, useAgentPortraitUrlResolver } from "@seosoyoung/soul-ui";
import { type AgendaKind } from "@seosoyoung/soul-ui/lib/pas-report-thread-core";
import { formatReturnTime, type Agenda } from "./pas-report-thread-model";
import type { PasReportThreadController } from "./use-pas-report-thread";

const KIND_TONE: Record<AgendaKind, string> = {
  question: "question", request: "question", review: "review", blocked: "blocked", running: "running", verifying: "awaiting_verification",
};

export function PasThreadRail({ controller }: { controller: PasReportThreadController }) {
  const { t, i18n } = useTranslation();
  const { groups, processed, activeCardId, now, cardsError } = controller;
  // 카드 목록을 못 읽었으면 진행 중과 보류함은 0이 아니라 알 수 없는 것이다.
  const unknownCount = Boolean(cardsError);
  const numberFormat = new Intl.NumberFormat(i18n.language);
  const sections = [
    { id: "pending", title: t("persistent.thread.pending"), items: groups.pending.map(agenda => ({ agenda, note: null as string | null })), always: true },
    { id: "running", title: t("persistent.thread.running"), items: groups.running.map(agenda => ({ agenda, note: null as string | null })), always: true },
    { id: "snoozed", title: t("persistent.thread.snoozed"), items: groups.snoozed.map(agenda => ({ agenda, note: formatReturnTime(agenda.snoozedUntil!, now, t, i18n.language) })), always: false },
    { id: "processed", title: t("persistent.thread.processed"), items: processed.map(item => ({ agenda: item.agenda, note: item.label })), always: false },
  ];
  return <aside className="pas-rt-rail" aria-label={t("persistent.thread.agendas")} data-testid="pas-rt-rail">
    <div className="pas-rt-rail-sections">
      {sections.filter(section => section.items.length || section.always).map(section =>
        <section key={section.id} aria-label={section.title}>
          <div className="pas-rt-rail-head"><h2>{section.title}</h2><span className="pas-rt-rail-count">{unknownCount && section.id === "running" ? "–" : numberFormat.format(section.items.length)}</span></div>
          <ul className="pas-rt-rail-list">
            {section.items.map(({ agenda, note }) => <RailRow key={agenda.cardId} agenda={agenda} note={note}
              section={section.id} active={agenda.cardId === activeCardId} onSelect={() => controller.select(agenda.cardId)} />)}
          </ul>
        </section>)}
    </div>
    <div className="pas-rt-rail-foot">
      {unknownCount
        ? <div className="pas-rt-rail-error" role="alert" data-testid="pas-rt-rail-error">
          <span>{t("persistent.thread.cardListError")}</span>
          <Button variant="outline" onClick={controller.retryCards}>{t("persistent.retry")}</Button>
        </div>
        : <p className="pas-rt-hold-note">{t("persistent.thread.holdCount", { count: numberFormat.format(groups.holdCount) })}</p>}
    </div>
  </aside>;
}

function RailRow({ agenda, note, section, active, onSelect }: {
  agenda: Agenda; note: string | null; section: string; active: boolean; onSelect(): void;
}) {
  const { t } = useTranslation();
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portrait = agenda.portraitUrl ?? (agenda.agentId ? resolvePortrait(agenda.agentId) : null);
  const kind = t(`persistent.thread.kind.${agenda.kind}`);
  const title = agenda.number === null ? agenda.title : t("persistent.thread.numberedAgenda", { number: agenda.number, title: agenda.title });
  return <li>
    <button type="button" className="pas-rt-rail-item" data-active={active || undefined} data-kind={agenda.kind} data-card-id={agenda.cardId}
      data-section={section} data-has-portrait={portrait ? "true" : undefined} aria-current={active ? "true" : undefined}
      aria-label={`${title}, ${kind}${note ? `, ${note}` : ""}`} onClick={onSelect}>
      {agenda.number === null ? null : <span className="pas-rt-rail-number">#{agenda.number}</span>}
      <span className="pas-rt-rail-kind"><StatusChip label={kind} tone={KIND_TONE[agenda.kind]} /></span>
      {note ? <span className="pas-rt-rail-status">{section === "snoozed" ? <Badge variant="info" size="sm">{note}</Badge> : <StatusChip label={note} tone="done" />}</span> : null}
      <span className="pas-rt-rail-title">{agenda.title}</span>
      {portrait ? <img className="pas-rt-rail-portrait" src={portrait} alt="" width={24} height={24} /> : null}
    </button>
  </li>;
}
