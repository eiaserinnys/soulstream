import type { CardExecutionState } from '../../../packages/soul-ui/src/cards/card-execution-state';
import {ApiHttpError} from '../api/clientCore';
import type { ApiClient } from '../api/client';
import type { CardStatus } from '../../../packages/wire-schema/generated/typescript/index';
import type { CardDetail, CardDto, CardExecutionResult, CardMutationResult } from '../api/cardTypes';
import { captureAuthScope, subscribeAuthScope } from './auth-scope';
import { useCardStore } from '../store/cardStore';
import { CARD_STATUS_LABELS } from '../../../packages/wire-schema/src/card_status_labels';
import { cardDependencyStopReason, type CardDependency } from '../../../packages/wire-schema/src/card_dependency_display';

type Attempt={key:string;version:number;requestId?:string;timer?:ReturnType<typeof setTimeout>;deadline?:number;timeout?:ReturnType<typeof setTimeout>};
const executionAttempts=new Map<string,Attempt>();
const states=new Map<string,CardExecutionState>();
export const cardExecutionState=(id:string)=>states.get(id);
/** 선행 카드 한 장의 상태 칩 글. 충족되지 않은 채 보관된 선행은 「대기」가 아니라 「보관됨」이다(웹 cardDependencyStatus와 같다). */
export function cardDependencyStatus(dep: CardDependency): { label: string; tone: 'error' | 'neutral' } {
  return cardDependencyStopReason(dep) === 'archived' ? { label: '보관됨', tone: 'error' } : { label: CARD_STATUS_LABELS[dep.status], tone: 'neutral' };
}
export const cardDependencyLabel = (dep: CardDependency) => dep.number == null ? dep.title : `#${dep.number}`;
export const unmetCardDependencies = (card: Pick<CardDto, 'dependsOn'>) => card.dependsOn?.filter(dep => !dep.met) ?? [];
export const CARD_DEPENDENCY_START_TITLE = '선행 카드가 끝나지 않았습니다';
export function cardDependencyStartMessage(card: Pick<CardDto, 'dependsOn'>) {
  const names = unmetCardDependencies(card).map(dep => `${cardDependencyLabel(dep)}(${cardDependencyStatus(dep).label})`).join(', ');
  return `${names}이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?`;
}
/** 사용자가 시작 확인에서 취소했다. 실패가 아니므로 안내를 띄우지 않는다. */
export class CardTransitionDeclined extends Error { constructor() { super('카드 시작을 취소했습니다.'); } }
export class CardExecutionSettingsRequired extends Error {constructor(readonly card:CardDto){super('실행 설정을 보완하세요.');}}
const writes = new Map<string,{next:CardStatus;promise:Promise<CardMutationResult>}>();
const listeners = new Set<() => void>();
export const cardWritePending = (id: string) => writes.has(id);
export const subscribeCardWrites = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach((listener) => listener());
subscribeAuthScope(()=>{for(const attempt of executionAttempts.values()){clearTimeout(attempt.timer);clearTimeout(attempt.timeout);}executionAttempts.clear();states.clear();writes.clear();notify();});
export function cardExecutionProblem(error:unknown){
  const status=Number((error as {status?:number})?.status);
  return status===401||status===403?'로그인과 카드 접근 권한을 확인해 주세요.':status===409?'카드가 변경되었습니다. 최신 상태를 확인해 주세요.':status===422?'카드를 시작하지 못했습니다. 다시 시도해 주세요.':'연결을 확인한 뒤 다시 시도해 주세요.';
}
function apply(result:CardExecutionResult){
  const store=useCardStore.getState(),detail=store.details[result.card.id];
  if(detail)store.putDetail({...detail,card:result.card});else store.putCard(result.card);
}
async function execute(api:ApiClient,id:string,attempt:Attempt,scope:string):Promise<CardExecutionResult>{
  try{
    const result=await (attempt.requestId?api.getCardExecution(id,attempt.requestId):api.executeCard(id,attempt.version,attempt.key));
    if(captureAuthScope().generation!==scope)throw new Error('카드 시작 확인이 취소되었습니다.');
    attempt.requestId=result.execution.requestId;apply(result);
    if(result.execution.state==='pending'){
      if(!attempt.deadline){
        attempt.deadline=Date.now()+30000;
        attempt.timeout=setTimeout(()=>{
          clearTimeout(attempt.timer);
          states.set(id,{phase:'delayed',message:'시작 확인이 지연되고 있습니다'});notify();
        },30000);
      }
      const delayed=Date.now()>=attempt.deadline;
      states.set(id,{phase:delayed?'delayed':'pending',message:delayed?'시작 확인이 지연되고 있습니다':'시작 중…'});
      if(!delayed)attempt.timer=setTimeout(()=>{
        if(captureAuthScope().generation!==scope||executionAttempts.get(id)!==attempt)return;
        void tracked(id,()=>execute(api,id,attempt,scope)).catch(()=>undefined);
      },1000);
    }else{clearTimeout(attempt.timeout);executionAttempts.delete(id);states.delete(id);}
    notify();return result;
  }catch(error){
    if(captureAuthScope().generation===scope){
      clearTimeout(attempt.timeout);clearTimeout(attempt.timer);
      if([400,403,404,409,422].includes(Number((error as {status?:number}).status)))executionAttempts.delete(id);
      if(error instanceof ApiHttpError){
        const body=(()=>{try{return JSON.parse(error.body);}catch{return null;}})();
        if(body?.detail?.error?.code==='CARD_EXECUTION_SETTINGS_REQUIRED'){states.delete(id);notify();throw new CardExecutionSettingsRequired(useCardStore.getState().rows[id]);}
      }
      const message=cardExecutionProblem(error);states.set(id,{phase:'error',message});notify();throw new Error(message);
    }
    throw error;
  }
}
function tracked(id:string,operation:()=>Promise<CardMutationResult>,next:CardStatus='running'){
  const work=operation();writes.set(id,{next,promise:work});notify();
  return work.finally(()=>{if(writes.get(id)?.promise===work)writes.delete(id);notify();});
}
/** Only an unchanged selection is a no-op; workflow state does not restrict moves. */
export function cardTransitionProblem(detail: CardDetail, next: CardStatus): string | null {
  if (next !== 'running' && detail.card.status === next) return '이미 이 단계입니다.';
  return null;
}
export function performCardTransition(api: ApiClient, source: CardDto, next: CardStatus, operationId: string,
  reason?: string, isActive: () => boolean = () => true, confirmStart?: (card: CardDto) => Promise<boolean>):Promise<CardMutationResult> {
  const existing=writes.get(source.id);
  if(existing)return next==='running'&&existing.next==='running'?existing.promise:Promise.reject(new Error('이 카드를 저장 중입니다.'));
  const scope = captureAuthScope().generation;
  return tracked(source.id,async()=>{
    const detail = await api.getCard(source.id);
    if (!isActive() || captureAuthScope().generation !== scope) throw new Error('카드 이동이 취소되었습니다.');
    useCardStore.getState().putDetail(detail);
    if (next !== 'running' && detail.card.status !== source.status) throw new Error('카드 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.');
    const problem = cardTransitionProblem(detail, next);
    if (problem) throw new Error(problem);
    if(next==='running'){
      const card=detail.card,prior=executionAttempts.get(card.id);
      if(!prior&&confirmStart&&unmetCardDependencies(card).length){
        const accepted=await confirmStart(card);
        if(!accepted)throw new CardTransitionDeclined();
        if(!isActive()||captureAuthScope().generation!==scope)throw new Error('카드 이동이 취소되었습니다.');
      }
      if(!prior&&!card.assigneeSessionId&&(!card.nodeId||!card.assigneeAgentId||!card.modelPreset))throw new CardExecutionSettingsRequired(card);
      const attempt=prior??{key:operationId,version:card.version};
      clearTimeout(attempt.timer);clearTimeout(attempt.timeout);attempt.deadline=undefined;executionAttempts.set(card.id,attempt);
      states.set(card.id,{phase:'pending',message:'시작 중…'});notify();
      return execute(api,card.id,attempt,scope);
    }
    const result = await api.setCardStatus(source.id, next, detail.card.version, operationId, reason?.trim() || undefined);
    if (!result.card) throw new Error('저장 결과에 카드가 없습니다. 최신 상태를 다시 확인해 주세요.');
    return result;
  },next);
}
