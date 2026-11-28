import type {CardExecutionState} from "./card-execution-state";
import {cardRequest,cardPath,cardMutationKey,CardApiError,type CardTranslate} from "./card-api";
import type {CardRow} from "./card-types";
export interface CardExecutionResult {card:CardRow;execution:{requestId:string;sessionId:string;state:"started"|"already_running"|"pending"}}
export interface CardExecutionSettings {folderId:string;nodeId:string|null;agentId:string|null;modelPreset:string|null}
type Attempt={key:string;version:number;t?:CardTranslate;requestId?:string;timer?:ReturnType<typeof setTimeout>;deadline?:number;timeout?:ReturnType<typeof setTimeout>;onResult?:(result:CardExecutionResult)=>void};
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
export function cardExecutionProblem(error:unknown,t?:CardTranslate){
  const status=error instanceof CardApiError?error.status:0;
  if(status===401||status===403)return t?.("cards.executionAccess")??"로그인과 카드 접근 권한을 확인해 주세요."; // i18n-ignore: 공용 실행 오류의 한국어 기본값.
  if(status===409)return t?.("cards.executionConflict")??"카드가 변경되었습니다. 최신 상태를 확인해 주세요."; // i18n-ignore: 공용 실행 오류의 한국어 기본값.
  if(status===422)return (error instanceof CardApiError&&error.serverDetail)||t?.("cards.executionRefused")||"카드를 시작하지 못했습니다. 다시 시도해 주세요."; // i18n-ignore: 공용 실행 오류의 한국어 기본값.
  return t?.("cards.executionConnection")??"연결을 확인한 뒤 다시 시도해 주세요."; // i18n-ignore: 공용 실행 오류의 한국어 기본값.
}
const starting = (t?:CardTranslate) => t?.("cards.starting")??"시작 중…"; // i18n-ignore: 공용 실행 상태의 한국어 기본값.
const delayedMessage = (t?:CardTranslate) => t?.("cards.executionDelayed")??"시작 확인이 지연되고 있습니다"; // i18n-ignore: 공용 실행 상태의 한국어 기본값.

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
      if(generation!==scope)throw new Error(attempt.t?.("cards.executionCheckCancelled")??"카드 시작 확인이 취소되었습니다."); // i18n-ignore: 공용 실행 오류의 한국어 기본값.
      attempt.requestId=result.execution.requestId;attempt.onResult?.(result);
      if(result.execution.state==='pending'){
        if(!attempt.deadline){
          attempt.deadline=Date.now()+30000;
          attempt.timeout=setTimeout(()=>{
            clearTimeout(attempt.timer);
            states.set(id,{phase:"delayed",message:delayedMessage(attempt.t)});notify();
          },30000);
        }
        const delayed=Date.now()>=attempt.deadline;
        states.set(id,{phase:delayed?"delayed":"pending",message:delayed?delayedMessage(attempt.t):starting(attempt.t)});
        if(!delayed)observe(id,attempt,scope);
      }else{clearTimeout(attempt.timeout);attempts.delete(id);states.delete(id);}
      return result;
    }catch(error){
      if(generation===scope){
        clearTimeout(attempt.timeout);clearTimeout(attempt.timer);
        if(error instanceof CardApiError&&[400,403,404,409,422].includes(error.status))attempts.delete(id);
        const message=cardExecutionProblem(error,attempt.t);states.set(id,{phase:"error",message});
        if(error instanceof CardApiError)throw new CardApiError(message,error.status,error.code,error.serverDetail,error.hasServerMessage);
        throw new Error(message);
      }
      throw error;
    }
  })();
  writes.set(id,work);notify();
  try{return await work;}finally{if(writes.get(id)===work)writes.delete(id);notify();}
}
export function executeCard(id:string,version:number,onResult?:(result:CardExecutionResult)=>void,t?:CardTranslate):Promise<CardExecutionResult>{
  const existing=writes.get(id);if(existing)return existing;
  const attempt=attempts.get(id)??{key:cardMutationKey(),version};
  clearTimeout(attempt.timer);clearTimeout(attempt.timeout);attempt.deadline=undefined;attempt.t=t;attempt.onResult=onResult??attempt.onResult;attempts.set(id,attempt);
  states.set(id,{phase:"pending",message:starting(t)});
  return request(id,attempt,generation);
}
export function saveCardExecutionSettings(id:string,version:number,value:CardExecutionSettings,key:string,t?:CardTranslate){
  return cardRequest<{card:CardRow}>(cardPath(id)+"/execution-settings","POST",{...value,expectedVersion:version,idempotencyKey:key},undefined,t);
}
