import {useState} from 'react';
import {Button} from '../../../packages/soul-ui/src/components/ui/button';
import {DEFAULT_CHAT_FONT_SIZE} from '../../../packages/soul-ui/src/lib/chat-typography';
import {CatalogSelectionField} from '../components/CatalogSelectionField';
import {PostItCardView,PostItGrid} from './PostItCardPresentation';
import {cardGroups,groupWidgetCards,type WidgetCard} from '../../../plugins/chatgpt-card-renderer/src/card-groups';

/** The same inbox container, section heads and paper, with a read-only owner. */
export function ReadOnlyCardList({cards,total,hasData,disabled=false,refresh,notice='',summaryOverride}: {
 cards:readonly WidgetCard[];total:number;hasData:boolean;disabled?:boolean;
 refresh?:{pending:boolean;onRefresh():void};notice?:string;summaryOverride?:string;
}) {
 const [filter,setFilter]=useState('all');
 const groups=groupWidgetCards(cards).filter(group=>filter==='all'||filter===group.id);
 const count=groups.reduce((total,group)=>total+group.cards.length,0);
 return <div className="v3-readonly-card-list">
  <header className="v3-detail-section-head widget-head">
   <h3>업무 카드</h3>
   <div className="widget-controls v3-succession-assignment">
    <CatalogSelectionField label="상태" ariaLabel="카드 상태 필터" value={filter} disabled={disabled}
     selectedLabel={cardGroups.find(g=>g.id===filter)?.label??'전체'}
     options={[{value:'all',label:'전체'},...cardGroups.map(g=>({value:g.id,label:g.label}))]} onValueChange={setFilter}/>
    {refresh?<Button id="refresh" className="v3-catalog-select-trigger h-auto sm:h-auto" variant="outline" disabled={disabled||refresh.pending} onClick={refresh.onRefresh}>새로고침</Button>:null}
   </div>
  </header>
  <p id="summary" aria-live="polite" className="widget-meta">{summaryOverride??(hasData?(total>cards.length?`${total}개 중 ${cards.length}개 불러옴 · ${count}개 표시`:`${cards.length}개 불러옴 · ${count}개 표시`):'카드를 불러오는 중…')}</p>
  <div id="cards" className="v3-card-inbox">{groups.map(group=><section key={group.id} data-card-group={group.id}>
   <div className="v3-detail-section-head"><h3>{group.label}</h3><span>{group.cards.length}개</span></div>
   <PostItGrid fontSize={DEFAULT_CHAT_FONT_SIZE}>{group.cards.map(card=><PostItCardView key={card.id} id={card.id} title={card.title} status={card.status}
    fontSize={DEFAULT_CHAT_FONT_SIZE} activity={card.preview??null} assigneeName={card.assignee||'담당 없음'} readOnly showStatus={false}
    supplement={card.status==='cancelled'?'취소됨':card.status==='unknown'?'상태 확인 필요':undefined}/>)}</PostItGrid>
  </section>)}</div>
  <p id="notice" role="status" className="widget-meta">{notice||(hasData&&!count?(cards.length?'이 상태의 카드가 없습니다':'표시할 카드가 없습니다'):'')}</p>
 </div>;
}
