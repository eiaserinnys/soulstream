import {act,renderHook,waitFor} from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import {useCompletedCards,type CompletedBrowser} from '../useCompletedCards';
import {usePlannerFolder} from '../usePlannerFolder';
import {usePlannerFolderDetail} from '../usePlannerReads';
import {cardFixture} from '../../test-support/cards';
import {usePlannerStore} from '../../store/plannerStore';

test('hidden skips completed reads; shown pages keep fixed period and reset on invalidation',async()=>{
  const card=cardFixture({id:'done',status:'done'});
  const listCompletedCards=jest.fn().mockResolvedValueOnce({cards:[card],nextCursor:'next'})
    .mockResolvedValueOnce({cards:[card, {...card,id:'done-2'}],nextCursor:null})
    .mockResolvedValue({cards:[card],nextCursor:null});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook<CompletedBrowser,{shown:boolean}>(({shown})=>useCompletedCards(api,'folder-1',shown),{initialProps:{shown:false}});
  expect(listCompletedCards).not.toHaveBeenCalled();
  hook.rerender({shown:true});await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  const first=listCompletedCards.mock.calls[0][0];
  expect(Date.parse(first.completedBefore)-Date.parse(first.completedFrom)).toBe(7*24*60*60*1000);
  act(()=>hook.result.current.loadMore());await waitFor(()=>expect(hook.result.current.cards).toHaveLength(2));
  expect(listCompletedCards.mock.calls[1][0]).toEqual({...first,cursor:'next'});
  act(()=>usePlannerStore.getState().invalidate('folder'));
  await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  expect(listCompletedCards.mock.calls[2][0]).toMatchObject({folderId:first.folderId,q:first.q,limit:60});
  expect(Date.parse(listCompletedCards.mock.calls[2][0].completedBefore)).toBeGreaterThanOrEqual(Date.parse(first.completedBefore));
  expect(listCompletedCards.mock.calls[2][0].cursor).toBeUndefined();
});
test('both folder reads always exclude done independently of completion visibility',async()=>{
  const getFolderSnapshot=jest.fn().mockResolvedValue({folder:{id:'folder-1'},cards:[]});
  const getPlannerFolder=jest.fn().mockResolvedValue({folder:{id:'folder-1'},cards:[],subfolders:{items:[],nextCursor:null},sessions:{items:[],nextCursor:null}});
  const api={getFolderSnapshot,getPlannerFolder} as unknown as ApiClient;
  const snapshot=renderHook(()=>usePlannerFolder(api,'folder-1',true,false));
  const aggregate=renderHook(()=>usePlannerFolderDetail(api,'folder-1'));
  await waitFor(()=>expect(snapshot.result.current.loading).toBe(false));
  await waitFor(()=>expect(aggregate.result.current.loading).toBe(false));
  expect(getFolderSnapshot).toHaveBeenCalledWith('folder-1',{includeCompleted:false});
  expect(getPlannerFolder).toHaveBeenCalledWith('folder-1',{includeCompleted:false});
});
