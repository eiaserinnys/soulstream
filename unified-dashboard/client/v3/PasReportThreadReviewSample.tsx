import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { PersistentReportEntry } from "../../../packages/wire-schema/src/persistent_report";
import { PasReportThreadReport } from "./pas-report-thread/PasReportThreadReport";
import { buildPasThreadFixture } from "./pas-report-thread/pas-report-thread-fixtures";
import { usePersistentCardCompletion } from "./usePersistentCardCompletion";

/**
 * 결재형 보고 창 견본. 운영 형태의 표본(긴 제목, 질문, 검수, 막힘, 진행 중, 미뤄 둠)을 운영과 같은 부품에 그대로 넣는다.
 * 카드 목록과 상세는 표본에서 받으므로 읽을 때는 서버에 묻지 않고, 카드 패널의 세션 칸도 스트림을 열지 않는다.
 * 답, 커멘트, 처분, 미루기는 실제 카드 저장소 경로로 가므로 표본에서는 서버가 없어 실패 안내가 뜬다.
 */
export function PasReportThreadReviewSample({ empty = false, defaultOpen = false }: { empty?: boolean; defaultOpen?: boolean }) {
  const fixture = useMemo(() => buildPasThreadFixture(), []);
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<PersistentReportEntry[]>(() => empty ? [] : fixture.entries);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    useCardStore.setState(state => ({ byId: { ...state.byId, ...fixture.cards }, details: { ...state.details, ...fixture.details } }));
  }, [fixture]);
  const cardTransition = useCallback(async (cardId: string, status: "done" | "on_hold" | "review") => {
    const key = `card_${cardId}`;
    if (status === "review") setEntries(current => current.some(entry => entry.key === key) ? current : [...current, ...fixture.entries.filter(entry => entry.key === key)]);
    else setEntries(current => current.filter(entry => entry.key !== key));
  }, [fixture]);
  const completion = usePersistentCardCompletion(() => undefined, cardTransition);
  const visible = useMemo(() => completion.filterEntries(entries), [completion.filterEntries, completion.revision, entries]);
  const dismiss = useCallback(async (key: string) => setEntries(current => current.filter(entry => entry.key !== key)), []);
  return <div className="v3-components-row" data-testid="pas-report-thread-sample">
    <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>보고 창 열기</Button>
    <PasReportThreadReport open={open} onClose={() => setOpen(false)} openTriggerRef={trigger} entries={visible} completion={completion}
      dismissReport={dismiss} startCardId={empty ? null : fixture.entries[0].card_id ?? null} cardSource={empty ? [] : fixture.list} liveSessions={false} />
  </div>;
}
