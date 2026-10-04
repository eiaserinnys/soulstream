import {cardRequest,cardPath,cardMutationKey,CardApiError} from "./card-api";
import type {CardRow} from "./card-types";
export interface CardExecutionResult {card:CardRow;execution:{requestId:string;sessionId:string;state:"started"|"already_running"|"pending"}}
export interface CardExecutionSettings {folderId:string;nodeId:string|null;agentId:string|null;modelPreset:string|null}
const attempts=new Map<string,{key:string;version:number;requestId?:string}>();
const writes=new Map<string,Promise<CardExecutionResult>>();
const listeners=new Set<()=>void>();
export const cardExecutionPending=(id:string)=>writes.has(id);
export const subscribeCardExecution=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const notify=()=>listeners.forEach(f=>f());
export async function executeCard(id:string,version:number):Promise<CardExecutionResult>{
  const existing=writes.get(id);if(existing)return existing;
  const attempt=attempts.get(id)??{key:cardMutationKey(),version};attempts.set(id,attempt);
  const work=(async()=>{
    try{
      const result=await cardRequest<CardExecutionResult>(cardPath(id)+"/execute","POST",{expectedVersion:attempt.version,idempotencyKey:attempt.key});
      attempt.requestId=result.execution.requestId;
      if(result.execution.state!=='pending')attempts.delete(id);
      return result;
    }catch(error){if(error instanceof CardApiError && [400,403,404,409,422].includes(error.status))attempts.delete(id);throw error;}
  })();
  writes.set(id,work);notify();
  try{return await work;}finally{writes.delete(id);notify();}
}
export function saveCardExecutionSettings(id:string,version:number,value:CardExecutionSettings,key:string){
  return cardRequest<{card:CardRow}>(cardPath(id)+"/execution-settings","POST",{...value,expectedVersion:version,idempotencyKey:key});
}
