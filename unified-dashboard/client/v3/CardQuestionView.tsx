import { useState } from "react";
import { Button, DashboardIconCap, Input } from "@seosoyoung/soul-ui";
import { Check } from "lucide-react";
import type { CardQuestion } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
export function CardQuestionView({cardId,question}:{cardId:string;question:CardQuestion}) {
 const [answer,setAnswer]=useState(""),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const confirm=async()=>{if(!answer.trim()||pending)return;setPending(true);setError(null);try{await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(question.id)}/answer`,{answer:answer.trim()});}catch(e){setError(String(e));}finally{setPending(false);}};
 return <div className="v3-card-question"><p>{question.text}</p>{question.answer?<p>답: {question.answer}</p>:<>
  {question.options?.length?<div className="v3-card-answer-options">{question.options.map(o=><Button key={o} variant={answer===o?"default":"outline"} disabled={pending} aria-pressed={answer===o} onClick={()=>setAnswer(o)}>{o}</Button>)}</div>:null}
  <form className="v3-card-add" onSubmit={e=>{e.preventDefault();void confirm();}}><Input aria-label={`답: ${question.text}`} placeholder="답을 입력하세요" value={answer} disabled={pending} onChange={e=>setAnswer(e.target.value)}/><DashboardIconCap label="확인" type="submit" disabled={pending||!answer.trim()}><Check className="h-4 w-4"/></DashboardIconCap></form>
 </>}{error?<p role="alert" className="v3-card-error">{error}</p>:null}</div>;
}
