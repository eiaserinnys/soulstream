import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import { CardRow } from "./CardRow";
export function CardInbox({folders}:{folders:readonly CatalogFolder[]}) {
 const byId=useCardStore(s=>s.byId);const groups=groupCards(Object.values(byId));
 const empty = !groups.attention.length && !groups.running.length && !groups.queued.length;
 return <div className="v3-card-inbox">{empty ? <div className="v3-card-inbox-empty"><strong>지금은 확인할 것이 없습니다</strong><span>아래에서 한 줄로 맡기면 대기열에 올라갑니다.</span></div> : null}{(["attention","running","queued"] as const).filter(group=>groups[group].length>0).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:"확인할 것",running:"진행 중",queued:"대기열"}[group]}</h2><span>{groups[group].length}</span></div>
  <div className="v3-task-list">{group==="queued"?<CardQueue cards={groups.queued} renderRow={(card,handle)=><CardRow card={card} folders={folders} handle={handle} showQueueAction={false} today queueNumber={groups.queued.findIndex(c=>c.id===card.id)+1}/>}/>:groups[group].map(card=><CardRow key={card.id} card={card} folders={folders} today/>)}</div>
 </section>)}</div>;
}
