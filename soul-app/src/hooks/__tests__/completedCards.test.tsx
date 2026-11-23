import {act,renderHook,waitFor} from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import {useCompletedCards,type CompletedBrowser} from '../useCompletedCards';
import {usePlannerFolder} from '../usePlannerFolder';
import {usePlannerFolderDetail} from '../usePlannerReads';
import {cardFixture} from '../../test-support/cards';
import {usePlannerStore} from '../../store/plannerStore';
import {CARD_REFRESH_WINDOW_MS} from '../../lib/card-refresh-window';
import {mergeCompletedRefresh} from '../../../../packages/soul-ui/src/cards/completed-cards';
// useCompletedCards applies its 250ms search debounce after mount; let it fire inside act
// before RNTL's cleanup yields to the event loop.
const settleTimers = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });

test('hidden skips reads; invalidation refreshes the first page and keeps the loaded tail',async()=>{
  const card=cardFixture({id:'done',status:'done',completedAt:'2026-01-02T00:00:00Z'});
  const listCompletedCards=jest.fn().mockResolvedValueOnce({cards:[card],nextCursor:'next'})
    .mockResolvedValueOnce({cards:[card, {...card,id:'done-2'}],nextCursor:null})
    .mockResolvedValue({cards:[card],nextCursor:'next'});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook<CompletedBrowser,{shown:boolean}>(({shown})=>useCompletedCards(api,'folder-1',shown),{initialProps:{shown:false}});
  expect(listCompletedCards).not.toHaveBeenCalled();
  hook.rerender({shown:true});await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  const first=listCompletedCards.mock.calls[0][0];
  expect(Date.parse(first.completedBefore)-Date.parse(first.completedFrom)).toBe(7*24*60*60*1000);
  act(()=>hook.result.current.loadMore());await waitFor(()=>expect(hook.result.current.cards).toHaveLength(2));
  expect(listCompletedCards.mock.calls[1][0]).toEqual({...first,cursor:'next'});
  const resetKey=hook.result.current.resetKey;
  act(()=>usePlannerStore.getState().invalidate('folder'));
  await waitFor(()=>expect(listCompletedCards).toHaveBeenCalledTimes(3));
  await waitFor(()=>expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.cards).toHaveLength(2);
  expect(hook.result.current.resetKey).toBe(resetKey);
  expect(listCompletedCards.mock.calls[2][0]).toMatchObject({folderId:first.folderId,q:first.q,limit:60});
  expect(Date.parse(listCompletedCards.mock.calls[2][0].completedBefore)).toBeGreaterThanOrEqual(Date.parse(first.completedBefore));
  expect(listCompletedCards.mock.calls[2][0].cursor).toBeUndefined();
  await settleTimers();
});

test('카드 갱신은 한 창으로 묶고 폴더 무효화는 즉시 다시 받는다',async()=>{
  jest.useFakeTimers();
  try {
    const a=cardFixture({id:'a',status:'done',completedAt:'2026-01-02'});
    const listCompletedCards=jest.fn().mockResolvedValue({cards:[a],nextCursor:null});
    const api={listCompletedCards} as unknown as ApiClient;
    const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
    const flush=()=>act(async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();});
    await flush();
    expect(listCompletedCards).toHaveBeenCalledTimes(1);

    act(()=>{usePlannerStore.getState().invalidate('card');usePlannerStore.getState().invalidate('card');});
    await act(async()=>{jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS-1);});
    expect(listCompletedCards).toHaveBeenCalledTimes(1);
    await act(async()=>{jest.advanceTimersByTime(1);await Promise.resolve();await Promise.resolve();});
    expect(listCompletedCards).toHaveBeenCalledTimes(2);

    act(()=>usePlannerStore.getState().invalidate('folder'));
    await flush();
    expect(listCompletedCards).toHaveBeenCalledTimes(3);
    await flush();
    expect(hook.result.current.loading).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('완료 목록을 숨기면 예약을 취소하고 복귀 시 한 번만 읽는다',async()=>{
  jest.useFakeTimers();
  try {
    const listCompletedCards=jest.fn().mockResolvedValue({cards:[],nextCursor:null});
    const api={listCompletedCards} as unknown as ApiClient;
    const hook=renderHook<CompletedBrowser,{shown:boolean}>(({shown})=>useCompletedCards(api,'folder-1',shown),{initialProps:{shown:true}});
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    act(()=>usePlannerStore.getState().invalidate('card'));
    hook.rerender({shown:false});
    hook.rerender({shown:true});
    await act(async()=>{jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS);await Promise.resolve();await Promise.resolve();});
    expect(listCompletedCards).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test('폴더 카드 목록은 카드 사건을 묶고 폴더 사건은 즉시 반영한다',async()=>{
  jest.useFakeTimers();
  try {
    const getFolderSnapshot=jest.fn().mockResolvedValue({folder:{id:'folder-1'},cards:[]});
    const api={getFolderSnapshot} as unknown as ApiClient;
    renderHook(()=>usePlannerFolder(api,'folder-1',true,false));
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    act(()=>usePlannerStore.getState().invalidate('card'));
    await act(async()=>{jest.advanceTimersByTime(100);});
    act(()=>usePlannerStore.getState().invalidate('card'));
    expect(getFolderSnapshot).toHaveBeenCalledTimes(1);
    await act(async()=>{jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS);await Promise.resolve();await Promise.resolve();});
    expect(getFolderSnapshot).toHaveBeenCalledTimes(2);
    await act(async()=>{usePlannerStore.getState().invalidate('folder');await Promise.resolve();await Promise.resolve();});
    expect(getFolderSnapshot).toHaveBeenCalledTimes(3);
  } finally { jest.useRealTimers(); }
});

test('refresh merges the older tail, or replaces it when the first page is complete',()=>{
  const a={id:'a',completedAt:'2026-01-03'}, b={id:'b',completedAt:'2026-01-02'}, c={id:'c',completedAt:'2026-01-01'};
  const previous={cards:[a,b,c],cursor:'old'};
  expect(mergeCompletedRefresh({cards:[a,b],nextCursor:'new'},previous)).toEqual({cards:[a,b,c],cursor:'old'});
  expect(mergeCompletedRefresh({cards:[a,b],nextCursor:null},previous)).toEqual({cards:[a,b],cursor:null});
  expect(mergeCompletedRefresh({cards:[c],nextCursor:'new'},previous)).toEqual({cards:[c],cursor:'new'});
});

test('invalidation during a next page waits and refreshes once',async()=>{
  const a=cardFixture({id:'a',status:'done',completedAt:'2026-01-02'}),b={...a,id:'b',completedAt:'2026-01-01'};
  let resolve!: (value:{cards:typeof a[];nextCursor:string|null})=>void;
  const pending=new Promise<{cards:typeof a[];nextCursor:string|null}>(done=>{resolve=done;});
  const listCompletedCards=jest.fn().mockResolvedValueOnce({cards:[a],nextCursor:'next'}).mockReturnValueOnce(pending)
    .mockResolvedValue({cards:[a],nextCursor:'next'});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  act(()=>hook.result.current.loadMore());
  act(()=>{usePlannerStore.getState().invalidate('folder');usePlannerStore.getState().invalidate('folder');});
  expect(listCompletedCards).toHaveBeenCalledTimes(2);
  await act(async()=>{resolve({cards:[b],nextCursor:null});await pending;});
  await waitFor(()=>expect(listCompletedCards).toHaveBeenCalledTimes(3));
  await waitFor(()=>expect(hook.result.current.cards.map(card=>card.id)).toEqual(['a','b']));
  await settleTimers();
});

test('retry refreshes the first page while preserving the loaded tail',async()=>{
  const a=cardFixture({id:'a',status:'done',completedAt:'2026-01-02'}),b={...a,id:'b',completedAt:'2026-01-01'};
  const listCompletedCards=jest.fn().mockResolvedValueOnce({cards:[a],nextCursor:'next'})
    .mockResolvedValueOnce({cards:[b],nextCursor:null}).mockRejectedValueOnce(new Error('오류'))
    .mockResolvedValueOnce({cards:[a],nextCursor:'next'});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  act(()=>hook.result.current.loadMore());
  await waitFor(()=>expect(hook.result.current.cards).toHaveLength(2));
  act(()=>usePlannerStore.getState().invalidate('folder'));
  await waitFor(()=>expect(hook.result.current.error).toBe('오류'));
  act(()=>hook.result.current.retry());
  await waitFor(()=>expect(hook.result.current.error).toBeNull());
  expect(hook.result.current.cards.map(card=>card.id)).toEqual(['a','b']);
  await settleTimers();
});
test('a range error is reported apart from a read failure and is not retried',async()=>{
  const listCompletedCards=jest.fn().mockRejectedValueOnce(new Error('조회 실패')).mockResolvedValue({cards:[],nextCursor:null});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  await waitFor(()=>expect(hook.result.current.error).toBe('조회 실패'));
  expect(hook.result.current.invalidRange).toBe(false);
  act(()=>hook.result.current.setPeriod('custom'));
  await waitFor(()=>expect(listCompletedCards).toHaveBeenCalledTimes(2));
  act(()=>{hook.result.current.setStart('2026-12-31');hook.result.current.setEnd('2026-01-01');});
  expect(hook.result.current.invalidRange).toBe(true);
  expect(hook.result.current.error).toBe('시작일과 종료일을 확인해 주세요.');
  act(()=>hook.result.current.retry());
  await settleTimers();
  expect(listCompletedCards).toHaveBeenCalledTimes(2);
});

test('a failed refresh keeps the loaded cards, and repeated retry during the read sends one request',async()=>{
  const a=cardFixture({id:'a',status:'done',completedAt:'2026-01-02'});
  let resolve!: (value:{cards:typeof a[];nextCursor:string|null})=>void;
  const pending=new Promise<{cards:typeof a[];nextCursor:string|null}>(done=>{resolve=done;});
  const listCompletedCards=jest.fn().mockResolvedValueOnce({cards:[a],nextCursor:null}).mockRejectedValueOnce(new Error('갱신 실패'))
    .mockReturnValueOnce(pending).mockResolvedValue({cards:[a],nextCursor:null});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  await waitFor(()=>expect(hook.result.current.cards).toHaveLength(1));
  act(()=>usePlannerStore.getState().invalidate('folder'));
  await waitFor(()=>expect(hook.result.current.error).toBe('갱신 실패'));
  expect(hook.result.current.invalidRange).toBe(false);
  expect(hook.result.current.cards.map(card=>card.id)).toEqual(['a']);
  act(()=>{hook.result.current.retry();hook.result.current.retry();});
  expect(listCompletedCards).toHaveBeenCalledTimes(3);
  // 다시 받는 동안 안내는 남고(칸이 사라지거나 튀지 않는다) 조회 중으로 알린다.
  expect(hook.result.current.loading).toBe(true);
  expect(hook.result.current.error).toBe('갱신 실패');
  await act(async()=>{resolve({cards:[a],nextCursor:null});await pending;});
  await waitFor(()=>expect(hook.result.current.error).toBeNull());
  await settleTimers();
  expect(listCompletedCards).toHaveBeenCalledTimes(3);
  expect(hook.result.current.cards.map(card=>card.id)).toEqual(['a']);
});

test('a period change while an earlier read runs stays loading, drops the old answer and notice, then reads the new period once',async()=>{
  const old=cardFixture({id:'old',status:'done',completedAt:'2026-01-02'}),fresh={...old,id:'fresh'};
  let resolve!: (value:{cards:typeof old[];nextCursor:string|null})=>void;
  const pending=new Promise<{cards:typeof old[];nextCursor:string|null}>(done=>{resolve=done;});
  const listCompletedCards=jest.fn().mockRejectedValueOnce(new Error('조회 실패')).mockReturnValueOnce(pending)
    .mockResolvedValue({cards:[fresh],nextCursor:null});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  await waitFor(()=>expect(hook.result.current.error).toBe('조회 실패'));
  // 검수 창의 「자동 요청 시작」처럼 갱신 조회가 붙잡힌 채로 기간을 바꾼다.
  act(()=>usePlannerStore.getState().invalidate('folder'));
  expect(listCompletedCards).toHaveBeenCalledTimes(2);
  act(()=>hook.result.current.setPeriod('30'));
  expect(hook.result.current).toMatchObject({loading:true,error:null,cards:[]});
  expect(listCompletedCards).toHaveBeenCalledTimes(2);
  await act(async()=>{resolve({cards:[old],nextCursor:null});await pending;});
  await waitFor(()=>expect(hook.result.current.cards.map(card=>card.id)).toEqual(['fresh']));
  expect(hook.result.current.loading).toBe(false);
  expect(listCompletedCards).toHaveBeenCalledTimes(3);
  const next=listCompletedCards.mock.calls[2][0];
  expect(Date.parse(next.completedBefore)-Date.parse(next.completedFrom)).toBe(30*24*60*60*1000);
  await settleTimers();
});
test('an invalid range entered while an earlier read runs shows the notice without the loader, and a valid period after it loads again',async()=>{
  let resolve!: (value:{cards:never[];nextCursor:string|null})=>void;
  const pending=new Promise<{cards:never[];nextCursor:string|null}>(done=>{resolve=done;});
  const listCompletedCards=jest.fn().mockReturnValueOnce(pending).mockResolvedValue({cards:[],nextCursor:null});
  const api={listCompletedCards} as unknown as ApiClient;
  const hook=renderHook(()=>useCompletedCards(api,'folder-1',true));
  expect(hook.result.current.loading).toBe(true);
  act(()=>{hook.result.current.setPeriod('custom');hook.result.current.setStart('2026-12-31');hook.result.current.setEnd('2026-01-01');});
  expect(hook.result.current).toMatchObject({invalidRange:true,loading:false,error:'시작일과 종료일을 확인해 주세요.'});
  // 앞 조회가 아직 돌 때 읽을 수 있는 기간으로 돌아오면 새 조회가 줄 서므로 다시 조회 중이다.
  act(()=>hook.result.current.setPeriod('7'));
  expect(hook.result.current).toMatchObject({invalidRange:false,loading:true,error:null});
  await act(async()=>{resolve({cards:[],nextCursor:null});await pending;});
  await waitFor(()=>expect(listCompletedCards).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(hook.result.current.loading).toBe(false));
  await settleTimers();
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
