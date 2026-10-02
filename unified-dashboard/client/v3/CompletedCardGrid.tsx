import { type ReactNode } from "react";
import { Button,Input } from "@seosoyoung/soul-ui";
import { CompletedVirtualGrid } from "@seosoyoung/soul-ui/cards/CompletedVirtualGrid";
import { completedPeriods } from "@seosoyoung/soul-ui/cards/completed-cards";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type { CompletedBrowser } from "./use-completed-cards";
export function CompletedCardGrid({browser,renderCard}:{browser:CompletedBrowser;renderCard(card:CardRow):ReactNode}) {
  return <>
    <div className="v3-completed-controls">
      <div className="v3-completed-periods" role="group" aria-label="완료 기간">{completedPeriods.map(option=><Button key={option.value} size="sm" variant="ghost" aria-pressed={browser.period===option.value} onClick={()=>browser.setPeriod(option.value)}>{option.label}</Button>)}</div>
      {browser.period==="custom"?<div className="v3-completed-dates"><Input type="date" aria-label="완료 시작일" value={browser.start} onChange={event=>browser.setStart(event.target.value)}/><Input type="date" aria-label="완료 종료일" value={browser.end} onChange={event=>browser.setEnd(event.target.value)}/></div>:null}
      <Input aria-label="제목 또는 요청 검색" placeholder="제목 또는 요청 검색" value={browser.search} onChange={event=>browser.setSearch(event.target.value)}/>
    </div>
    <div className="v3-card-board-lane v3-completed-viewport" data-testid="completed-viewport">
      {browser.error?<p role="alert" className="v3-card-board-empty">{browser.error}<Button variant="ghost" size="sm" onClick={browser.retry}>다시 불러오기</Button></p>:null}
      {browser.cards.length?<CompletedVirtualGrid key={browser.resetKey} data={browser.cards} computeItemKey={(_,card)=>card.id}
        listClassName="v3-completed-grid" itemClassName="v3-completed-grid-item" endReached={browser.loadMore}
        overscan={{main:0,reverse:0}}
        style={{height:"100%",width:"100%"}} itemContent={(_,card)=>renderCard(card)}/>
        :<p className="v3-card-board-empty" role="status">{browser.loading?"완료 카드를 불러오는 중…":"선택한 기간에 완료 카드가 없습니다"}</p>}
    </div>
  </>;
}
