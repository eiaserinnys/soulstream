import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { reviewCardItems, reviewNow, reviewNowHistory, reviewNotes, reviewSession } from "./components-review-fixtures";
import { CardCheckItems } from "./CardCheckItems";
import { CardNowPanel } from "./CardNowPanel";
import { CardNotes } from "./CardNotes";
import "./v3-card-check-items.css";


export function CardCheckItemsSamples() {
 const [items,setItems]=useState(reviewCardItems);
 const [target,setTarget]=useState<number|null>(null);
 const [notice,setNotice]=useState("샘플 조작은 이 화면 안에서만 바뀝니다.");
 const activeCount=items.filter(item=>item.display!=="confirmed"&&item.display!=="dropped").length;
 const now=reviewNow;
 const confirm=async(itemId:number,confirmed:boolean)=>{
  setItems(current=>current.map(item=>item.id===itemId?confirmed?{...item,state:"done",confirmed:{at:new Date().toISOString(),rev:item.rev},display:"confirmed"}:{...item,state:"doing",confirmed:null,display:"changed",reopened:"샘플에서 확인을 풀었습니다."}:item));
 };
 const comments=reviewCardItems.map(item=>item.id);
 return <div className="v3-card-check-items-samples" data-testid="card-check-items-samples">
  <p role="status" className="v3-components-label">{notice}</p>
  <div className="v3-card-check-items-sample-layout">
   <div className="v3-card-check-items-sample-main">
    <CardNowPanel now={now} nowHistory={reviewNowHistory} itemsCount={items.length} activeCount={activeCount}/>
    <CardCheckItems items={items} onConfirmChange={confirm} onTargetItem={id=>{setTarget(id);setNotice(`${id}번 항목이 커멘트 입력 대상으로 선택됐습니다.`);}}/>
    {target!==null?<div className="v3-card-check-items-sample-target"><span>대상: {target}번 {items.find(item=>item.id===target)?.title}</span>
     <Button size="sm" variant="ghost" onClick={()=>setTarget(null)}>대상 해제</Button></div>:null}
   </div>
   <div className="v3-card-check-items-sample-notes"><CardNotes brief="첫 문단의 인계 요약입니다.\n\n내부 식별자와 기술 경로는 실제 값 그대로 표시합니다." notes={reviewNotes}
    sessions={[{sessionId:reviewSession.agentSessionId,cardId:"components-card",displayName:reviewSession.displayName??"로젤린",nodeId:"eiaserinnys",agentId:"roselin",status:"completed",createdAt:reviewNow.updatedAt,updatedAt:reviewNow.updatedAt,callerSessionId:null}]}/></div>
  </div>
  <p className="v3-components-label">활성 항목 {activeCount}개 · 항목 ID {comments.join(", ")}</p>
 </div>;
}
