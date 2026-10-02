import React,{useEffect,useRef,useState} from 'react';
import { FlatList,Text,View,useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import type { CompletedBrowser } from '../../hooks/useCompletedCards';
import { useTokens } from '../../theme';
import { createPostItRoles } from '../../theme/postItRoles';
import { completedGridLayout } from '../../../../packages/soul-ui/src/cards/completed-cards';
import { CompletedCardFilters } from './CompletedCardFilters';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { PostItCard } from './PostItCard';
export function CompletedCardCollection({api,browser,onOpen}:{api:ApiClient|null;browser:CompletedBrowser;onOpen(id:string):void}) {
  const t=useTokens(),paper=createPostItRoles(t,'compact'),window=useWindowDimensions();
  const [width,setWidth]=useState(window.width);
  const columns=completedGridLayout(width,paper.width,paper.gap,t.uiSpacing.sm).columns;
  const list=useRef<FlatList<CardDto>>(null);
  useEffect(()=>{list.current?.scrollToOffset({offset:0,animated:false});},[browser.resetKey]);
  return <View testID="completed-card-collection" onLayout={event=>setWidth(event.nativeEvent.layout.width)} style={{gap:t.uiSpacing.sm}}>
    <PlannerSectionHeader variant="board" title="완료" count={browser.cards.length} countSuffix="개 표시"/>
    <CompletedCardFilters browser={browser}/>
    <FlatList ref={list} key={columns} data={browser.cards} numColumns={columns} keyExtractor={card=>card.id}
      style={{height:Math.min(window.height,paper.height*2+paper.gap)}} contentContainerStyle={{paddingHorizontal:t.uiSpacing.sm,paddingVertical:t.uiSpacing.xs}}
      columnWrapperStyle={columns>1?{gap:paper.gap}:undefined} initialNumToRender={columns*2} maxToRenderPerBatch={columns*2} windowSize={5}
      renderItem={({item})=><View style={{width:paper.width,marginBottom:paper.gap}}><PostItCard api={api} card={item} variant="compact" onOpen={()=>onOpen(item.id)}/></View>}
      showsVerticalScrollIndicator={false} onEndReached={browser.loadMore} onEndReachedThreshold={0.5}
      ListEmptyComponent={<Text style={{...t.foundation.typography.body,color:t.colors.textSecondary}}>{browser.loading?'완료 카드를 불러오는 중…':'선택한 기간에 완료 카드가 없습니다'}</Text>}/>
  </View>;
}
