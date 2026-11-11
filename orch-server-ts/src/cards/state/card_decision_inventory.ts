import type {CardDecisionCommand} from './card_decision_facts.js';
/** Actor/input-only gates run before lookup, locking and version checks. No card facts enter this table. */
export const CARD_COMMAND_ENTRY_RULES:Partial<Record<CardDecisionCommand,readonly {
 when:'always'|'hasMode'|'requestedSpoken';kinds:readonly string[];session?:true;failure:string;
}[]>>={
 ANSWER_QUESTION:[{when:'always',kinds:['user'],failure:'humanAnswer'}],
 ADD_COMMENT:[
  {when:'hasMode',kinds:['agent'],session:true,failure:'commentTrustedMode'},
  {when:'requestedSpoken',kinds:['agent','llm'],failure:'commentTrustedSpoken'},
 ],
};
const control='cards/card_control_plane_service.ts';
/** PR 2: explicit operational connections; remaining families still use legacy services. */
export const CARD_RUNTIME_DECISION_CALLS={
 CREATE:[`${control}#createCard`,`${control}#createCardTx`],
 SET_STATUS:[`${control}#setCardStatus`],REQUEST_REVIEW:[`${control}#requestCardReview`],
 HUMAN_INPUT:[`${control}#resumeBlockedCardOnHumanInput`],ASK_QUESTION:[`${control}#askQuestion`],
 ANSWER_QUESTION:[`${control}#answerQuestion`],WITHDRAW_QUESTION:[`${control}#withdrawQuestion`],
 ADD_COMMENT:[`${control}#addComment`,`${control}#addCommentTx`],
} as const;
export const CARD_RUNTIME_DECISION_IMPORTERS=[control] as const;
export const CARD_DECISION_SOURCES={
 CLAIM:[control,'claim'],CREATE:[control,'createCardMutation'],SET_STATUS:[control,'setCardStatus'],REQUEST_REVIEW:[control,'requestCardReview'],HUMAN_INPUT:[control,'resumeBlockedCardOnHumanInput'],ASK_QUESTION:[control,'askQuestion'],ANSWER_QUESTION:[control,'answerQuestion'],WITHDRAW_QUESTION:[control,'withdrawQuestion'],ADD_COMMENT:[control,'applyAddCommentTx'],START_WORK:[control,'startCardWork'],CONFIRM_EXECUTION:[control,'recordExecution'],DISPATCH:[control,'recordDispatch'],BLOCK_FOR_LIMIT:[control,'blockCardForLimit'],RESUME_SHORT_LIMIT:[control,'resumeLimitedCard'],RESUME_LONG_LIMIT:[control,'resumeDispatchedCard'],RESUME_VERIFICATION:[control,'resumeVerificationCard'],NOTE_MISSING:[control,'noteMissingAssignee'],BULK_SET_STATUS:['cards/card_maintenance_service.ts','bulkSetCardStatus'],MERGE_SOURCE:['cards/card_maintenance_service.ts','mergeCards'],UPDATE_UNSTARTED:['cards/card_maintenance_service.ts','updateUnstartedCard'],SAVE_EXECUTION_SETTINGS:[control,'saveExecutionSettings'],PATCH_CARD_CONTROL:[control,'patchCard'],REGISTER_REPLACEMENT:['control_plane/repositories/session_card_replacement.ts','applySessionCardReplacement'],
} as const satisfies Record<CardDecisionCommand,readonly [string,string]>;
export const CARD_RUNTIME_SQL_WRITERS=[
 'cards/card_control_plane_service.ts:INSERT',
 'cards/control_plane/card_patch.ts:UPDATE',
 'cards/control_plane/card_move.ts:UPDATE',
] as const;

/** Public entry families, independent of the state-dependent permission result. */
export const CARD_COMMAND_ENTRANCES:Record<CardDecisionCommand,readonly ('human'|'agent'|'server')[]>={
 CREATE:['human','agent'],SET_STATUS:['human','agent','server'],REQUEST_REVIEW:['human','agent'],HUMAN_INPUT:['server'],
 ASK_QUESTION:['human','agent'],ANSWER_QUESTION:CARD_COMMAND_ENTRY_RULES.ANSWER_QUESTION![0]!.kinds.map(kind=>({user:'human',agent:'agent',system:'server'} as const)[kind as 'user'|'agent'|'system']),WITHDRAW_QUESTION:['human','agent'],ADD_COMMENT:['human','agent'],
 START_WORK:['agent'],CONFIRM_EXECUTION:['human','agent','server'],DISPATCH:['server'],BLOCK_FOR_LIMIT:['server'],RESUME_SHORT_LIMIT:['server'],RESUME_LONG_LIMIT:['server'],RESUME_VERIFICATION:['server'],NOTE_MISSING:['server'],
 BULK_SET_STATUS:['agent'],MERGE_SOURCE:['agent'],UPDATE_UNSTARTED:['agent'],SAVE_EXECUTION_SETTINGS:['human','agent'],PATCH_CARD_CONTROL:['human','agent'],REGISTER_REPLACEMENT:['agent'],CLAIM:['agent'],
};

export const CARD_COMMAND_CALLERS:Record<CardDecisionCommand,readonly string[]>={
 ...Object.fromEntries(Object.entries(CARD_DECISION_SOURCES).map(([command,source])=>[command,[source.join('#')]])) as unknown as Record<CardDecisionCommand,readonly string[]>,
 CREATE:[`${control}#createCard`,`${control}#createCardTx`,`${control}#createCardMutation`],
 ADD_COMMENT:[`${control}#addComment`,`${control}#addCommentTx`,`${control}#applyAddCommentTx`,'cards/card_work_dispatch_service.ts#accept'],
 CONFIRM_EXECUTION:['cards/card_execution_service.ts#observe','cards/card_execution_service.ts#observeOnce','cards/card_execution_service.ts#observePendingForNode','cards/card_execution_service.ts#sendAndObserve'],
 REGISTER_REPLACEMENT:['control_plane/repositories/session_card_replacement.ts#applySessionCardReplacement'],
};

export const CARD_COMMENT_ENTRY_ACTORS={direct:['human','agent'],followup:['agent']} as const;
