import React from 'react';
import type {ApiClient} from '../../api/client';
import type {useCardTransition} from '../../hooks/useCardTransition';
import {CardAssignmentSheet} from './CardAssignmentSheet';
export function CardTransitionSettings({api,action,onExecuted}:{api:ApiClient|null;action:ReturnType<typeof useCardTransition>;onExecuted?():void}){
 const card=action.settingsCard;
 return card?<CardAssignmentSheet api={api} mode="edit" startAfterSave value={{folderId:card.folderId,nodeId:card.nodeId,agentId:card.assigneeAgentId,modelPreset:card.modelPreset}}
  onClose={()=>action.setSettingsCard(null)} onSave={async value=>{await action.saveSettingsAndExecute(value);onExecuted?.();}}/>:null;
}
