import React,{useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import { FlatList,Text,View,useWindowDimensions,type StyleProp,type ViewStyle,type ViewToken } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { useCompletedCards } from '../../hooks/useCompletedCards';
import { useCardDisplay } from '../../hooks/useCardDisplay';
import { useTokens } from '../../theme';
import { createPostItRoles } from '../../theme/postItRoles';
import { completedGridLayout } from '../../../../packages/soul-ui/src/cards/completed-cards';
import type { FolderCardDisplay } from './CardBoardWorkspace';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CompletedCardFilters } from './CompletedCardFilters';
import { PostItCard } from './PostItCard';
import { CardDetailSheet } from './CardDetailSheet';

/** One vertical native list owns the folder and completed rows; no nested virtual scroll. */
export function FolderWorkspaceList({api,folderId,active,cardDisplay:controlledDisplay,header,footer,contentContainerStyle,onOpenSession}:{
  api:ApiClient|null;folderId:string;active:boolean;cardDisplay?:FolderCardDisplay;header:ReactNode;footer:ReactNode;
  contentContainerStyle:StyleProp<ViewStyle>;onOpenSession?(id:string):void;
}) {
  const t=useTokens(),paper=createPostItRoles(t,'compact'),window=useWindowDimensions();
  const localDisplay=useCardDisplay(folderId),display=controlledDisplay??localDisplay;
  const browser=useCompletedCards(api,folderId,active&&display.includeCompleted);
  const [width,setWidth]=useState(window.width),[selected,setSelected]=useState<string|null>(null);
  const columns=completedGridLayout(width-2*t.foundation.pageInset,paper.width,paper.gap,0).columns;
  const list=useRef<FlatList<CardDto>>(null);
  const currentBrowser=useRef(browser);currentBrowser.current=browser;
  const onVisibleRows=useCallback(({viewableItems}:{viewableItems:ViewToken<CardDto>[]})=>{
    const current=currentBrowser.current,last=current.cards.at(-1);
    if(last&&viewableItems.some(row=>row.isViewable&&row.item.id===last.id))current.loadMore();
  },[]);
  useEffect(()=>{if(display.includeCompleted)list.current?.scrollToOffset({offset:0,animated:false});},[browser.resetKey]);
  return <>
    <FlatList ref={list} testID="task-workspace-scroll" key={columns} style={{flex:1}} data={browser.cards} numColumns={columns}
      onLayout={event=>setWidth(event.nativeEvent.layout.width)} contentContainerStyle={[contentContainerStyle,{gap:paper.gap}]} keyboardShouldPersistTaps="handled"
      keyExtractor={card=>card.id} columnWrapperStyle={columns>1?{gap:paper.gap}:undefined}
      initialNumToRender={columns*2} maxToRenderPerBatch={columns*2} windowSize={5} showsVerticalScrollIndicator={false}
      ListHeaderComponent={<View style={{gap:t.spacing.lg}}>{header}{display.includeCompleted?<View style={{gap:t.uiSpacing.sm}}>
        <PlannerSectionHeader variant="board" title="완료" count={browser.cards.length} countSuffix="개 표시"/><CompletedCardFilters browser={browser}/>
        {!browser.cards.length?<Text style={{...t.foundation.typography.body,color:t.colors.textSecondary}}>{browser.loading?'완료 카드를 불러오는 중…':'선택한 기간에 완료 카드가 없습니다'}</Text>:null}
      </View>:null}</View>}
      renderItem={({item})=><View style={{width:paper.width}}><PostItCard api={api} card={item} variant="compact" onOpen={()=>setSelected(item.id)}/></View>}
      onViewableItemsChanged={onVisibleRows} ListFooterComponent={<View style={{gap:t.spacing.lg}}>{footer}</View>} onEndReached={browser.loadMore} onEndReachedThreshold={0.5}/>
    <CardDetailSheet api={api} cardId={selected} onClose={()=>setSelected(null)} onOpenSession={onOpenSession}/>
  </>;
}
