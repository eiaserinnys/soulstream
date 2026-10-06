import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { CardDetailPane } from "./CardDetailPane";
import { PersistentSessionTaskList } from "./PersistentSessionTaskList";
import { reviewCard, reviewCardItems, reviewDetail, reviewNow, reviewNowHistory, reviewSession, reviewTitle } from "./components-review-fixtures";
import { useEffect } from "react";
import "./v3-persistent-task-list.css";

const summaryAssignee = { ...reviewSession, agentSessionId: "persistent-summary-review-session", agentPortraitUrl: undefined };

const taskFixture: CardRow[] = ([
  ["running", 7], ["blocked", 98], ["review", 412], ["queued", 1024], ["todo", 55],
  ["done", 76], ["cancelled", 77],
] as const).map(([status, number], index) => ({
  ...reviewCard,
  id: `persistent-task-${status}`,
  assigneeSessionId: summaryAssignee.agentSessionId,
  number,
  status,
  title: index === 0 ? reviewTitle : `카드 ${number}`,
  positionKey: String.fromCharCode(97 + index),
  queuePositionKey: String.fromCharCode(97 + index),
}));

const requestedCard: CardRow = {
  ...reviewCard,
  id: "persistent-summary-requested",
  assigneeSessionId: summaryAssignee.agentSessionId,
  number: 31,
  title: reviewTitle,
  request: ("요청의 첫 문장과 다음 문장이 같은 읽기 요약 안에서 자연스럽게 이어집니다. 좁은 패널에서도 본문이 네 줄로 접히고 아래 경과와 카드 열기 동작이 계속 보이는지 확인합니다. ").repeat(4).slice(0,330),
  now: reviewNow,
  items: reviewCardItems.slice(1, 8),
};

const widthSamples: { width: 318 | 340 | 392; detail: CardDetail }[] = [
  { width: 318, detail: { ...reviewDetail, card: requestedCard, nowHistory: reviewNowHistory } },
  { width: 340, detail: { ...reviewDetail, card: { ...requestedCard, id: "persistent-summary-340" }, nowHistory: reviewNowHistory } },
  { width: 392, detail: { ...reviewDetail, card: { ...requestedCard, id: "persistent-summary-392" }, nowHistory: reviewNowHistory } },
];

export function PersistentSessionTaskListReviewSample() {
  const catalog = useDashboardStore(state => state.catalog);
  const setCatalog = useDashboardStore(state => state.setCatalog);
  useEffect(() => {
    if (catalog?.sessionList?.some(session => session.agentSessionId === summaryAssignee.agentSessionId && session.agentName)) return;
    const current = useDashboardStore.getState().catalog;
    if (current?.sessionList?.some(session => session.agentSessionId === summaryAssignee.agentSessionId && session.agentName)) return;
    setCatalog({
      ...(current ?? { folders: [], sessions: {} }),
      sessionList: [...(current?.sessionList ?? []).filter(session => session.agentSessionId !== summaryAssignee.agentSessionId), summaryAssignee],
    });
  }, [catalog, setCatalog]);

  useEffect(() => () => {
      const latest = useDashboardStore.getState().catalog;
      if (!latest) return;
      const sessionList = (latest.sessionList ?? []).filter(session => session.agentSessionId !== summaryAssignee.agentSessionId);
      if (sessionList.length !== latest.sessionList?.length) {
        useDashboardStore.getState().setCatalog({ ...latest, sessionList });
      }
  }, []);

  return <div className="v3-persistent-task-review" data-testid="persistent-task-review-sample">
    <div className="v3-persistent-task-review-list">
      <PersistentSessionTaskList cards={taskFixture} onOpenCard={() => {}}/>
    </div>
    <div className="v3-persistent-task-review-details">
      {widthSamples.map(({width,detail})=><div key={width} className="v3-persistent-task-review-detail" style={{width,height:width===318?704:width===340?900:784,maxWidth:"100%"}} data-detail-width={width}>
        <CardDetailPane variant="summary" cardId={detail.card.id} folders={[]} onClose={()=>{}} onOpenSession={()=>{}}
          onOpenCard={()=>{}} sampleDetail={detail}/>
      </div>)}
    </div>
  </div>;
}
