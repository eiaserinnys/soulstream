import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import { CardRow } from "./CardRow";
export function CardInbox({folders}:{folders:readonly CatalogFolder[]}) {
 const byId=useCardStore(s=>s.byId);const groups=groupCards(Object.values(byId));
 return <div className="v3-card-inbox">{(["attention","running","queued"] as const).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:"확인할 것",running:"진행 중",queued:"대기열"}[group]}</h2><span>{groups[group].length}개</span></div>
  <div className="v3-task-list">{group==="queued"?<CardQueue cards={groups.queued} renderRow={(card,handle)=><CardRow card={card} folders={folders} handle={handle} showQueueAction={false}/>}/>:groups[group].map(card=><CardRow key={card.id} card={card} folders={folders}/>)}{groups[group].length===0?<div className="v3-empty">카드가 없습니다.</div>:null}</div>
 </section>)}</div>;
}
