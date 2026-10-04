import {ApiHttpError} from '../api/clientCore';
import type { ApiClient } from '../api/client';
import type { CardDetail, CardDto, CardStatus } from '../api/cardTypes';
import { captureAuthScope } from './auth-scope';
import { useCardStore } from '../store/cardStore';

// Card IDs identify writes across separately constructed clients and hook instances.
const executionAttempts=new Map<string,{key:string;version:number;requestId?:string}>();
export class CardExecutionSettingsRequired extends Error {constructor(readonly card:CardDto){super('실행 설정을 보완하세요.');}}
const writes = new Set<string>();
const listeners = new Set<() => void>();
export const cardWritePending = (id: string) => writes.has(id);
export const subscribeCardWrites = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach((listener) => listener());

/** Only an unchanged selection is a no-op; workflow state does not restrict moves. */
export function cardTransitionProblem(detail: CardDetail, next: CardStatus): string | null {
  if (next !== 'running' && detail.card.status === next) return '이미 이 단계입니다.';
  return null;
}

export async function performCardTransition(api: ApiClient, source: CardDto, next: CardStatus, operationId: string,
  reason?: string, isActive: () => boolean = () => true) {
  if (writes.has(source.id)) throw new Error('이 카드를 저장 중입니다.');
  writes.add(source.id); notify();
  const scope = captureAuthScope().generation;
  try {
    const detail = await api.getCard(source.id);
    if (!isActive() || captureAuthScope().generation !== scope) throw new Error('카드 이동이 취소되었습니다.');
    useCardStore.getState().putDetail(detail);
    if (next !== 'running' && detail.card.status !== source.status) throw new Error('카드 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.');
    const problem = cardTransitionProblem(detail, next);
    if (problem) throw new Error(problem);
    if(next==='running'){
      const card=detail.card;
      const attemptKey=`${scope}:${source.id}`;
      const prior=executionAttempts.get(attemptKey);
      if(!prior&&!card.assigneeSessionId&&(!card.nodeId||!card.assigneeAgentId||!card.modelPreset))throw new CardExecutionSettingsRequired(card);
      const attempt=prior??{key:operationId,version:card.version};executionAttempts.set(attemptKey,attempt);
      try{
        const result=await api.executeCard(card.id,attempt.version,attempt.key);
        attempt.requestId=result.execution.requestId;
        useCardStore.getState().putCard(result.card);
        if(result.execution.state==='pending')throw new Error('실행 결과 확인 중입니다. 진행 중을 다시 선택하면 같은 요청으로 확인하고 미전달된 실행을 재시도합니다.');
        executionAttempts.delete(attemptKey);return result;
      }catch(error){
        if([400,403,404,409,422].includes(Number((error as {status?:number}).status)))executionAttempts.delete(attemptKey);
        if(!card.assigneeSessionId&&error instanceof ApiHttpError){
          const body=(()=>{try{return JSON.parse(error.body);}catch{return null;}})();
          if(body?.detail?.error?.code==='CARD_EXECUTION_SETTINGS_REQUIRED')throw new CardExecutionSettingsRequired(card);
        }
        throw error;
      }
    }
    const result = await api.setCardStatus(source.id, next, detail.card.version, operationId, reason?.trim() || undefined);
    if (!result.card) throw new Error('저장 결과에 카드가 없습니다. 최신 상태를 다시 확인해 주세요.');
    return result;
  } finally { writes.delete(source.id); notify(); }
}
