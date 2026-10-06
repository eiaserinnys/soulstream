import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardDetailPane } from "./CardDetailPane";
import { PersistentSessionTaskList } from "./PersistentSessionTaskList";
import { reviewCard, reviewCardItems, reviewDetail, reviewNow, reviewNowHistory, reviewSession, reviewTitle } from "./components-review-fixtures";
import "./v3-persistent-task-list.css";

const taskFixture: CardRow[] = ([
  ["running", 71], ["blocked", 72], ["review", 73], ["queued", 74], ["todo", 75],
  ["done", 76], ["cancelled", 77],
] as const).map(([status, number], index) => ({
  ...reviewCard,
  id: `persistent-task-${status}`,
  number,
  status,
  title: index === 0 ? reviewTitle : `카드 ${number}`,
  positionKey: String.fromCharCode(97 + index),
  queuePositionKey: String.fromCharCode(97 + index),
}));

const requestedCard: CardRow = {
  ...reviewCard,
  id: "persistent-summary-requested",
  number: 31,
  title: reviewTitle,
  request: "목록 너비와 관계 없이 요청 본문이 모두 읽히는지 확인합니다.\n\n긴 요청은 줄을 바꾸어 확인할 수 있습니다.",
  now: reviewNow,
  items: reviewCardItems.slice(1, 4),
};
const elapsedOnlyCard: CardRow = {
  ...requestedCard,
  id: "persistent-summary-elapsed-only",
  number: 32,
  request: "",
  attachments: [],
};
const requestWithoutElapsedCard: CardRow = {
  ...requestedCard,
  id: "persistent-summary-request-only",
  number: null,
  now: null,
  items: [],
};

const widthSamples: { width: 318 | 340 | 392; detail: CardDetail }[] = [
  { width: 318, detail: { ...reviewDetail, card: requestedCard, nowHistory: reviewNowHistory } },
  { width: 340, detail: { ...reviewDetail, card: elapsedOnlyCard, nowHistory: reviewNowHistory } },
  { width: 392, detail: { ...reviewDetail, card: requestWithoutElapsedCard, nowHistory: [] } },
];

export function PersistentSessionTaskListReviewSample() {
  return <div className="v3-persistent-task-review" data-testid="persistent-task-review-sample">
    <div className="v3-persistent-task-review-list">
      <PersistentSessionTaskList cards={taskFixture} onOpenCard={() => {}}/>
    </div>
    <div className="v3-persistent-task-review-details">
      {widthSamples.map(({width,detail})=><div key={width} className="v3-persistent-task-review-detail" style={{width,maxWidth:"100%"}} data-detail-width={width}>
        <CardDetailPane variant="summary" cardId={detail.card.id} folders={[]} onClose={()=>{}} onOpenSession={()=>{}}
          onOpenCard={()=>{}} sampleDetail={detail}/>
      </div>)}
    </div>
  </div>;
}
