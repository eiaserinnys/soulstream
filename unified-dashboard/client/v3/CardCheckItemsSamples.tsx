import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import type { CardCheckItem, CardComment, CardNow, CardNowHistoryEntry } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "./CardCheckItems";
import { CardNowPanel } from "./CardNowPanel";
import { CardNotes } from "./CardNotes";
import { reviewSession } from "./components-review-fixtures";
import "./v3-card-check-items.css";

const startedAt="2026-10-05T07:00:00Z";
const itemSeeds:CardCheckItem[]=[
 {id:1,title:"요청된 화면 상태가 실제 응답대로 보입니다",state:"todo",result:null,evidence:[],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:null,display:"todo"},
 {id:2,title:"세션 카드와 같은 실행 띠가 보입니다",state:"doing",result:"작업 화면에서 실행 중인 항목입니다.",evidence:[],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:null,display:"doing"},
 {id:3,title:"보고한 결과가 파란 바탕으로 보입니다",state:"done",result:"완료 결과를 확인할 수 있습니다.",evidence:[{type:"image",url:"https://example.test/card-check-items/capture.png",label:"완료 화면"}],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:{commentId:"sample-comment",kind:"comment",at:startedAt},createdAt:startedAt,reportedAt:startedAt,display:"reported"},
 {id:4,title:"다시 확인할 항목이 표시됩니다",state:"doing",result:"최신 설명을 읽어 주세요.",evidence:[{type:"link",url:"https://example.test/card-check-items/spec",label:"설계 설명"}],caveat:null,rev:2,confirmed:null,fixOpen:0,reopened:"변경된 화면을 한 번 더 확인해 주세요.",from:null,createdAt:startedAt,reportedAt:startedAt,display:"changed"},
 {id:5,title:"남겨진 고칠 점이 표시됩니다",state:"doing",result:"대상 댓글이 연결된 항목입니다.",evidence:[],caveat:"입력 폭이 좁은 화면을 확인해 주세요.",rev:2,confirmed:null,fixOpen:2,reopened:null,from:null,createdAt:startedAt,reportedAt:startedAt,display:"fix"},
 {id:6,title:"기존에 확인한 항목 하나",state:"done",result:"사용자가 이미 확인했습니다.",evidence:[],caveat:null,rev:1,confirmed:{at:startedAt,rev:1},fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:startedAt,display:"confirmed"},
 {id:7,title:"요청에서 뺀 항목",state:"dropped",result:"현재 범위에 포함되지 않습니다.",evidence:[{type:"image",url:"https://example.test/card-check-items/dropped.png",label:"제외 근거"}],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:startedAt,display:"dropped"},
 {id:8,title:"목록 점에는 잘리지 않고 포함됩니다",state:"todo",result:null,evidence:[],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:null,display:"todo"},
 {id:9,title:"긴 설명도 자연스럽게 줄바꿈하며 읽을 수 있습니다",state:"todo",result:"화면이 좁아도 전송 버튼과 다른 글을 밀지 않도록 내용을 나누어 확인합니다.",evidence:[],caveat:null,rev:1,confirmed:null,fixOpen:0,reopened:null,from:null,createdAt:startedAt,reportedAt:null,display:"todo"},
];
const sampleNow:CardNow={text:"상세 카드의 현재 진행 상황을 여기에서 확인합니다.",turn:"user",ask:"보고된 결과 두 개를 확인해 주세요.",updatedAt:"2026-10-05T08:00:00Z",sessionId:reviewSession.agentSessionId};
const sampleHistory:CardNowHistoryEntry[]=[
 {text:"이전 상황의 글은 길어도 현재 항목 자리와 판 높이를 움직이지 않습니다.",turn:"agent",ask:"결과를 작성하고 있습니다.",at:"2026-10-05T06:30:00Z"},
 {text:"사용자가 마지막으로 요청한 것을 확인하고 있습니다.",turn:"user",ask:"확인이 끝나면 완료를 알려 주세요.",at:"2026-10-05T07:00:00Z"},
 {text:"이 이력 값은 현재 now.text로 대체됩니다.",turn:"outside",ask:null,at:"2026-10-05T07:30:00Z"},
 {text:sampleNow.text,turn:sampleNow.turn,ask:sampleNow.ask,at:sampleNow.updatedAt},
];
const sampleNotes:CardComment[]=Array.from({length:6},(_,index)=>({id:`sample-note-${index+1}`,cardId:"components-card",authorKind:index%2?"user":"agent",authorId:index%2?"sample-user":"roselin",sessionId:index%2?null:reviewSession.agentSessionId,kind:"note",body:`노트 ${index+1} · 인계에 필요한 결정과 진행 내용을 기록합니다.`,createdAt:`2026-10-05T0${index+1}:00:00Z`}));

export function CardCheckItemsSamples() {
 const [items,setItems]=useState(itemSeeds);
 const [target,setTarget]=useState<number|null>(null);
 const [notice,setNotice]=useState("샘플 조작은 이 화면 안에서만 바뀝니다.");
 const activeCount=items.filter(item=>item.display!=="confirmed"&&item.display!=="dropped").length;
 const now=activeCount?sampleNow:{...sampleNow,ask:""};
 const confirm=async(itemId:number,confirmed:boolean)=>{
  setItems(current=>current.map(item=>item.id===itemId?confirmed?{...item,state:"done",confirmed:{at:new Date().toISOString(),rev:item.rev},display:"confirmed"}:{...item,state:"doing",confirmed:null,display:"changed",reopened:"샘플에서 확인을 풀었습니다."}:item));
 };
 const comments=itemSeeds.map(item=>item.id);
 return <div className="v3-card-check-items-samples" data-testid="card-check-items-samples">
  <p role="status" className="v3-components-label">{notice}</p>
  <div className="v3-card-check-items-sample-layout">
   <div className="v3-card-check-items-sample-main">
    <CardNowPanel now={now} nowHistory={sampleHistory} itemsCount={items.length} activeCount={activeCount}/>
    <CardCheckItems items={items} onConfirmChange={confirm} onTargetItem={id=>{setTarget(id);setNotice(`${id}번 항목이 커멘트 입력 대상으로 선택됐습니다.`);}}/>
    {target!==null?<div className="v3-card-check-items-sample-target"><span>대상: {target}번 {items.find(item=>item.id===target)?.title}</span>
     <Button size="sm" variant="ghost" onClick={()=>setTarget(null)}>대상 해제</Button></div>:null}
   </div>
   <div className="v3-card-check-items-sample-notes"><CardNotes brief="첫 문단의 인계 요약입니다.\n\n내부 식별자와 기술 경로는 실제 값 그대로 표시합니다." notes={sampleNotes}
    sessions={[{sessionId:reviewSession.agentSessionId,cardId:"components-card",displayName:reviewSession.displayName??"로젤린",nodeId:"eiaserinnys",agentId:"roselin",status:"completed",createdAt:startedAt,updatedAt:startedAt,callerSessionId:null}]}/></div>
  </div>
  <p className="v3-components-label">활성 항목 {activeCount}개 · 항목 ID {comments.join(", ")}</p>
 </div>;
}
