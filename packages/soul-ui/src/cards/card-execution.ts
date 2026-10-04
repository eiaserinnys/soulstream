import {cardRequest,cardPath,cardMutationKey,CardApiError} from "./card-api";
import type {CardRow} from "./card-types";
export interface CardExecutionResult {card:CardRow;execution:{requestId:string;sessionId:string;state:"started"|"already_running"|"pending"}}
export interface CardExecutionSettings {folderId:string;nodeId:string|null;agentId:string|null;modelPreset:string|null}
export interface CardExecutionState {phase:"pending"|"delayed"|"error";message:string}
type Attempt={key:string;version:number;requestId?:string;timer?:ReturnType<typeof setTimeout>;deadline?:number;timeout?:ReturnType<typeof setTimeout>;onResult?:(result:CardExecutionResult)=>void};
const attempts=new Map<string,Attempt>();
const states=new Map<string,CardExecutionState>();
const writes=new Map<string,Promise<CardExecutionResult>>();
const listeners=new Set<()=>void>();
let generation=0;
export const cardExecutionState=(id:string)=>states.get(id);
export const cardExecutionPending=(id:string)=>writes.has(id);
export const subscribeCardExecution=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const notify=()=>listeners.forEach(f=>f());
export function resetCardExecutions(){generation++;for(const attempt of attempts.values()){clearTimeout(attempt.timer);clearTimeout(attempt.timeout);}attempts.clear();states.clear();writes.clear();notify();}
export function cardExecutionProblem(error:unknown){
  const status=error instanceof CardApiError?error.status:0;
  return status===401||status===403?"로그인과 카드 접근 권한을 확인해 주세요.":status===409?"카드가 변경되었습니다. 최신 상태를 확인해 주세요.":status===422?"카드를 시작하지 못했습니다. 다시 시도해 주세요.":"연결을 확인한 뒤 다시 시도해 주세요.";
}
function observe(id:string,attempt:Attempt,scope:number){
  attempt.timer=setTimeout(()=>{
    if(generation!==scope||attempts.get(id)!==attempt)return;
    void request(id,attempt,scope).catch(()=>undefined);
  },1000);
}
async function request(id:string,attempt:Attempt,scope:number):Promise<CardExecutionResult>{
  const existing=writes.get(id);if(existing)return existing;
  const work=(async()=>{
    try{
      const result=await (attempt.requestId
        ?cardRequest<CardExecutionResult>(cardPath(id)+"/execution?"+new URLSearchParams({requestId:attempt.requestId}))
        :cardRequest<CardExecutionResult>(cardPath(id)+"/execute","POST",{expectedVersion:attempt.version,idempotencyKey:attempt.key}));
      if(generation!==scope)throw new Error("카드 시작 확인이 취소되었습니다.");
      attempt.requestId=result.execution.requestId;attempt.onResult?.(result);
      if(result.execution.state==='pending'){
        if(!attempt.deadline){
          attempt.deadline=Date.now()+30000;
          attempt.timeout=setTimeout(()=>{
            clearTimeout(attempt.timer);
            states.set(id,{phase:"delayed",message:"시작 확인이 지연되고 있습니다"});notify();
          },30000);
        }
        const delayed=Date.now()>=attempt.deadline;
        states.set(id,{phase:delayed?"delayed":"pending",message:delayed?"시작 확인이 지연되고 있습니다":"시작 중…"});
        if(!delayed)observe(id,attempt,scope);
      }else{clearTimeout(attempt.timeout);attempts.delete(id);states.delete(id);}
      return result;
    }catch(error){
      if(generation===scope){
        clearTimeout(attempt.timeout);clearTimeout(attempt.timer);
        if(error instanceof CardApiError&&[400,403,404,409,422].includes(error.status))attempts.delete(id);
        const message=cardExecutionProblem(error);states.set(id,{phase:"error",message});
        if(error instanceof CardApiError)throw new CardApiError(message,error.status,error.code);
        throw new Error(message);
      }
      throw error;
    }
  })();
  writes.set(id,work);notify();
  try{return await work;}finally{if(writes.get(id)===work)writes.delete(id);notify();}
}
export function executeCard(id:string,version:number,onResult?:(result:CardExecutionResult)=>void):Promise<CardExecutionResult>{
  const existing=writes.get(id);if(existing)return existing;
  const attempt=attempts.get(id)??{key:cardMutationKey(),version};
  clearTimeout(attempt.timer);clearTimeout(attempt.timeout);attempt.deadline=undefined;attempt.onResult=onResult??attempt.onResult;attempts.set(id,attempt);
  states.set(id,{phase:"pending",message:"시작 중…"});
  return request(id,attempt,generation);
}
export function saveCardExecutionSettings(id:string,version:number,value:CardExecutionSettings,key:string){
  return cardRequest<{card:CardRow}>(cardPath(id)+"/execution-settings","POST",{...value,expectedVersion:version,idempotencyKey:key});
}
