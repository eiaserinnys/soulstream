import { useEffect,useRef,useState } from 'react';
import type { ApiClient } from '../api/client';
import type { CardDto } from '../api/cardTypes';
import { completedBounds,localDate,mergeCompletedRefresh,type CompletedCardParams,type CompletedPeriod } from '../../../packages/soul-ui/src/cards/completed-cards';
import { usePlannerStore } from '../store/plannerStore';
import { useAuthScopeGeneration } from '../lib/auth-scope';

type Accumulated={cards:CardDto[];cursor:string|null};
export function useCompletedCards(api:ApiClient|null,folderId:string|undefined,enabled:boolean) {
  const scope=useAuthScopeGeneration();
  const revision=usePlannerStore(state=>state.invalidation.folder+state.invalidation.replay);
  const [period,setPeriod]=useState<CompletedPeriod>('7');
  const [start,setStart]=useState(()=>localDate(new Date(Date.now()-7*24*60*60*1000))),[end,setEnd]=useState(()=>localDate(new Date()));
  const [search,setSearch]=useState(''),[q,setQ]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>setQ(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  const invalidRange=period==='custom'&&!completedBounds(period,start,end,0);
  const key=JSON.stringify([scope,folderId,period,start,end,q]);
  const [page,setPage]=useState<{key:string;cards:CardDto[];cursor:string|null}>({key:'',cards:[],cursor:null});
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const busy=useRef(false),queued=useRef<(()=>void)|null>(null);
  const refresh=useRef<()=>void>(()=>{}),more=useRef<()=>void>(()=>{}),retry=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,dirty=false,loaded=false;
    let accumulated:Accumulated={cards:[],cursor:null};
    let params:CompletedCardParams|null=null;
    setPage({key:'',cards:[],cursor:null});setError(null);setLoading(false);
    const load=async(mode:'initial'|'refresh'|'more')=>{
      if(!active||!api||!enabled||invalidRange)return;
      if(busy.current){if(mode==='refresh')dirty=true;else if(mode==='initial')queued.current=()=>void load('initial');return;}
      // 안내는 다음 응답이 성공할 때 걷는다. 다시 받는 동안 안내와 단추, 완료 칸이 사라졌다 돌아오지 않는다.
      busy.current=true;setLoading(true);
      const after=mode==='more'?accumulated.cursor:null;
      const request=mode==='more'?params!:{folderId,...completedBounds(period,start,end,Date.now())!,q,limit:60};
      if(mode!=='more')params=request;
      try {
        const result=await api.listCompletedCards({...request,...(after?{cursor:after}:{})});
        if(!active)return;
        accumulated=mode==='refresh'?mergeCompletedRefresh(result,accumulated):mode==='more'
          ?{cards:[...new Map([...accumulated.cards,...result.cards].map(card=>[card.id,card])).values()],cursor:result.nextCursor}
          :{cards:result.cards,cursor:result.nextCursor};
        loaded=true;setPage({key,...accumulated});setError(null);
      }catch(cause){if(active)setError(cause instanceof Error?cause.message:String(cause));}
      finally {
        busy.current=false;
        if(active){setLoading(false);if(dirty){dirty=false;void load('refresh');}}
        else {const next=queued.current;queued.current=null;next?.();}
      }
    };
    refresh.current=()=>void load('refresh');
    more.current=()=>{if(accumulated.cursor)void load('more');};
    // 조회 중에 다시 눌러도 겹쳐 보내지 않는다. 진행 중인 조회가 결과를 정한다.
    retry.current=()=>{if(!busy.current)void load(loaded?'refresh':'initial');};
    if(enabled&&!invalidRange)void load('initial');
    return()=>{active=false;queued.current=null;};
  },[key,enabled,invalidRange,folderId,period,start,end,q,api]);
  const previousRevision=useRef(revision);
  useEffect(()=>{if(previousRevision.current!==revision){previousRevision.current=revision;refresh.current();}},[revision]);
  // error는 화면에 보일 글 하나다. invalidRange면 그 글은 범위 안내이고, 다시 받아도 고쳐지지 않는다.
  return {cards:enabled&&page.key===key?page.cards:[],loading,error:invalidRange?'시작일과 종료일을 확인해 주세요.':error,invalidRange,resetKey:key,
    period,setPeriod,start,setStart,end,setEnd,search,setSearch,loadMore:()=>more.current(),retry:()=>retry.current()};
}
export type CompletedBrowser=ReturnType<typeof useCompletedCards>;
