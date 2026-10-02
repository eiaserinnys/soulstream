jest.mock('@expo/vector-icons/Ionicons',()=> 'Ionicons');
import React from 'react';
import {FlatList,Text} from 'react-native';
import {act,render,waitFor} from '@testing-library/react-native';
import type {ApiClient} from '../../../api/client';
import {cardFixture} from '../../../test-support/cards';
import {FolderWorkspaceList} from '../FolderWorkspaceList';
jest.mock('../CardDetailSheet',()=>({CardDetailSheet:()=>null}));
jest.mock('../PostItCard',()=>({PostItCard:({card}:{card:{id:string}})=>require('react').createElement(require('react-native').Text,null,card.id)}));
test('loads the next completed page at its last visible row before a long folder footer',async()=>{
 const cards=Array.from({length:60},(_,index)=>cardFixture({id:'done-'+index,status:'done'}));
 const listCompletedCards=jest.fn().mockResolvedValueOnce({cards,nextCursor:'next'}).mockResolvedValueOnce({cards:[cardFixture({id:'next-card',status:'done'})],nextCursor:null});
 const screen=render(<FolderWorkspaceList api={{listCompletedCards} as unknown as ApiClient} folderId="folder-1" active cardDisplay={{includeCompleted:true,onChange:()=>{}}} header={<Text>폴더 카드 머리</Text>} footer={<Text>{'세션과 하위 폴더 '.repeat(50)}</Text>} contentContainerStyle={{padding:16}}/>);
 await waitFor(()=>expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(60));
 const onViewableItemsChanged=screen.UNSAFE_getByType(FlatList).props.onViewableItemsChanged;
 await act(async()=>onViewableItemsChanged({viewableItems:[{item:cards[59],isViewable:true,index:59,key:cards[59].id}],changed:[]}));
 await waitFor(()=>expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(61));
 expect(listCompletedCards.mock.calls[1][0]).toMatchObject({folderId:'folder-1',cursor:'next'});
});
