import { useEffect, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardBoard } from "./CardBoard";
import { PostItCard } from "./PostItCard";
import { V3ErrorNotice } from "./V3ErrorNotice";

/** Membership comes from the permission-filtered list, never the today's feed. */
export function CardInboxBoard() {
  const byId=useCardStore(state=>state.byId);
  const [ids,setIds]=useState<string[]|null>(null),[error,setError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    setIds(null);setError(null);
    void cardRequest<{cards:CardRow[]}>("/api/cards").then(({cards})=>{
      if(!active)return;
      useCardStore.getState().putCards(cards);setIds(cards.map(card=>card.id));
    }).catch(failure=>{if(active)setError(String(failure));});
    return ()=>{active=false;};
  },[attempt]);
  if(error)return <V3ErrorNotice message="카드를 불러오지 못했습니다." detail={error}>
    <Button size="sm" variant="ghost" onClick={()=>setAttempt(value=>value+1)}>다시 불러오기</Button>
  </V3ErrorNotice>;
  if(!ids)return <p className="v3-card-board-empty" role="status">카드를 불러오는 중…</p>;
  return <CardBoard cards={ids.map(id=>byId[id]).filter((card):card is CardRow=>Boolean(card))}
    renderCard={card=><PostItCard card={card} variant="compact"/>}/>;
}
