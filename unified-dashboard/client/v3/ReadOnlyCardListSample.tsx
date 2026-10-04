import {ReadOnlyCardList} from './ReadOnlyCardList';
import {useState} from 'react';
const cards=['review','blocked','running','queued','todo','done','cancelled','unknown'].map((status,index)=>({
 id:`readonly-sample-${index}`,title:'같은 정본 카드 본문을 표시합니다',status,assignee:'로젤린',updatedAt:null,
 preview:index===4?undefined:{kind:index%2?'instruction' as const:'report' as const,text:'읽기 전용 iframe과 같은 카드입니다. 작은 발췌 라벨 없이 원문 본문을 표시하고 상태 변경·완료·열기 동작은 제공하지 않습니다. '.repeat(5)},
}));
export function ReadOnlyCardListSample(){
 const [count,setCount]=useState(0);
 return <div className="v3-detail-scroll" data-testid="readonly-card-list-sample">
  <ReadOnlyCardList cards={cards} total={cards.length} hasData refresh={{pending:false,onRefresh:()=>setCount(value=>value+1)}} notice={count?`로컬 새로고침 ${count}회`:''}/>
 </div>;
}
