import { useRef } from "react";

import { OverviewSheet } from "./OverviewSheet";
import { PasReportOverviewScreen } from "./PasReportOverviewScreen";
import { usePasReportOverview } from "./use-pas-report-overview-1707";

export function PasReportOverviewMockup() {
  const openTriggerRef = useRef<HTMLButtonElement>(null);
  const taskToggleRef = useRef<HTMLButtonElement>(null);
  const overview = usePasReportOverview({ returnFocus: openTriggerRef, fallbackFocus: taskToggleRef });
  const promotedIds = new Set(overview.cards.filter(card => card.promoted).map(card => card.id));

  return <>
    <PasReportOverviewScreen card={overview.activeCard} pendingCards={overview.pendingCards} chatLog={overview.chatLog}
      taskCards={overview.taskCards} promotedIds={promotedIds} openTriggerRef={openTriggerRef} taskToggleRef={taskToggleRef}
      onPrev={() => overview.goPending(-1)} onNext={() => overview.goPending(1)}
      onOpenOverview={() => overview.openOverview(overview.activeCard.id)}
      onOpenCard={cardId => overview.openOverview(cardId)}>
      {overview.open ? <OverviewSheet
        card={overview.activeCard}
        stripCards={overview.stripCards}
        target={overview.target}
        composer={overview.composer}
        undo={overview.undo}
        questionReset={overview.questionReset}
        onSetActive={overview.setActive}
        onGo={overview.go}
        onClose={overview.closeOverview}
        onChoose={overview.chooseOption}
        onApplyAction={overview.applyAction}
        onSendInstruction={overview.sendInstruction}
        onUndo={overview.undoLast}
        onPickTarget={overview.setTarget}
        onClearTarget={() => overview.setTarget(null)}
        onComposerChange={overview.setComposer}
        onConfirmItem={overview.confirmItem}
      /> : null}
    </PasReportOverviewScreen>
  </>;
}
