import {createI18n} from "@soulstream/i18n";
import {I18nContext,useTranslation} from "react-i18next";
import {useContext,useState} from 'react';
import {FrameLoading} from '../../../packages/soul-ui/src/components/FrameLoading';
import {Button} from '../../../packages/soul-ui/src/components/ui/button';
import {DEFAULT_CHAT_FONT_SIZE} from '../../../packages/soul-ui/src/lib/chat-typography';
import {CatalogSelectionField} from '../components/CatalogSelectionField';
import {PostItCardView,PostItGrid} from './PostItCardPresentation';
import {cardGroups,groupWidgetCards,type WidgetCard} from '../../../plugins/chatgpt-card-renderer/src/card-groups';

const widgetI18n=createI18n("ko");

/** The same inbox container, section heads and paper, with a read-only owner. */
export function ReadOnlyCardList({cards,total,hasData,disabled=false,refresh,notice='',summaryOverride}: {
 cards:readonly WidgetCard[];total:number;hasData:boolean;disabled?:boolean;
 refresh?:{pending:boolean;onRefresh():void};notice?:string;summaryOverride?:string;
}) {
 const context=useContext(I18nContext);
 const {t}=useTranslation(undefined,{i18n:context?.i18n??widgetI18n});
 const [filter,setFilter]=useState('all');
 const groups=groupWidgetCards(cards).filter(group=>filter==='all'||filter===group.id);
 const groupLabel=(group:typeof cardGroups[number])=>t(`cards.widgetGroup.${group.id}`,{defaultValue:group.label});
 const selected=cardGroups.find(group=>group.id===filter);
 const count=groups.reduce((total,group)=>total+group.cards.length,0);
 return <div className="v3-readonly-card-list">
  <header className="v3-detail-section-head widget-head">
   <h2>{t("cards.workCards")}</h2>
   <div className="widget-controls v3-succession-assignment">
    <CatalogSelectionField label={t("cards.statusLabel")} ariaLabel={t("cards.statusFilter")} value={filter} disabled={disabled}
     selectedLabel={selected?groupLabel(selected):t("cards.all")}
     options={[{value:'all',label:t("cards.all")},...cardGroups.map(g=>({value:g.id,label:groupLabel(g)}))]} onValueChange={setFilter}/>
    {refresh?<Button id="refresh" className="v3-catalog-select-trigger h-auto sm:h-auto" variant="outline" disabled={disabled||refresh.pending} onClick={refresh.onRefresh}>{t("cards.refresh")}</Button>:null}
   </div>
  </header>
  {summaryOverride||hasData
   ?<p id="summary" aria-live="polite" className="widget-meta">{summaryOverride??(total>cards.length?t("cards.loadedAndTotal", {total,loaded:cards.length,count}):t("cards.loadedAndShown", {loaded:cards.length,count}))}</p>
   :<FrameLoading inline label={t("cards.loadingCards")}/>}
  <div id="cards" className="v3-card-inbox">{groups.map(group=><section key={group.id} data-card-group={group.id}>
   <div className="v3-detail-section-head"><h3>{groupLabel(group)}</h3><span>{t("cards.count",{count:group.cards.length})}</span></div>
   <PostItGrid fontSize={DEFAULT_CHAT_FONT_SIZE}>{group.cards.map(card=><PostItCardView t={t} key={card.id} id={card.id} title={card.title} status={card.status}
    fontSize={DEFAULT_CHAT_FONT_SIZE} activity={card.preview??null} assigneeName={card.assignee||t("cards.noAssignee")} readOnly showStatus={false}
    supplement={card.status==='cancelled'?t("cards.cancelled"):card.status==='unknown'?t("cards.statusUnknown"):undefined}/>)}</PostItGrid>
  </section>)}</div>
  <p id="notice" role="status" className="widget-meta">{notice||(hasData&&!count?(cards.length?t("cards.noCardsInStatus"):t("cards.noVisibleCards")):'')}</p>
 </div>;
}
