import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {Alert} from 'react-native';
import {useCardStore} from '../store/cardStore';
import type { ApiClient } from '../api/client';
import type { CardDto, CardStatus, CardAssignment } from '../api/cardTypes';
import { CardExecutionSettingsRequired, cardExecutionState, cardWritePending, performCardTransition, subscribeCardWrites } from '../lib/card-transition';
import { cardOperationId, useCardActions } from './useCardActions';
import { captureAuthScope } from '../lib/auth-scope';

export function useCardTransition(api: ApiClient | null, cardId: string) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [settingsCard,setSettingsCard]=useState<CardDto|null>(null);
  const settingsKey=useRef<string|null>(null);
  const { run } = useCardActions(api,(cause)=>{
    if(cause instanceof CardExecutionSettingsRequired)setSettingsCard(cause.card);
    else Alert.alert('카드 변경 실패',cause instanceof Error?cause.message:String(cause));
  });
  const [error, setError] = useState<string | null>(null);
  const pending = useSyncExternalStore(subscribeCardWrites, () => cardWritePending(cardId), () => false);
  const execution = useSyncExternalStore(subscribeCardWrites, () => cardExecutionState(cardId), () => undefined);
  const transition = (card: CardDto, next: CardStatus, reason?: string, isActive?: () => boolean) => {
    if (!api || pending) return Promise.resolve(false);
    const scope = captureAuthScope().generation;
    setError(null);
    return run(async () => {
      try { return await performCardTransition(api, card, next, cardOperationId(), reason, () => mounted.current && (!isActive || isActive())); }
      catch (cause) {
        if (!(cause instanceof CardExecutionSettingsRequired) && mounted.current && scope === captureAuthScope().generation && (!isActive || isActive())) setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    });
  };
  const saveSettingsAndExecute=async(value:CardAssignment)=>{
    if(!api||!settingsCard)return;
    if(!value.nodeId||!value.agentId||!value.modelPreset)throw new Error('노드·에이전트·모델을 선택하세요.');
    settingsKey.current??=cardOperationId();
    const saved=await api.saveCardExecutionSettings(settingsCard.id,value,settingsCard.version,settingsKey.current);
    if(!saved.card)throw new Error('저장된 카드를 확인하지 못했습니다.');
    useCardStore.getState().putCard(saved.card);
    const result=await performCardTransition(api,saved.card,'running',cardOperationId());
    if(result.card)setSettingsCard(null);
  };
  return { transition, pending, execution, error,settingsCard,setSettingsCard:(value:CardDto|null)=>{if(!value)settingsKey.current=null;setSettingsCard(value);},saveSettingsAndExecute };
}
