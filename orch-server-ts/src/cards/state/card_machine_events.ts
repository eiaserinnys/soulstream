/** Code locators are functions, rather than line numbers which drift after each PR. */
export const STATUS_LEAVES = {
  todo:"할 일", queued:"대기열", running:"실행 중", question:"질문으로 막힘",
  noReport:"보고 없이 막힘", other:"사유 없이 막힘", limit:"한도로 막힘",
  verification:"검증 대기", review:"검수 대기", hold:"보류", done:"완료", cancelled:"취소",
} as const;
export type StatusLeaf = keyof typeof STATUS_LEAVES;
export type CardEvent = { type:string };
const control = "cards/card_control_plane_service.ts";
export const EVENT_SOURCES: Record<string, string[]> = {};
export const EVENT_LABELS: Record<string,string> = {};
export function source(event:string, label:string, ...locations:string[]) {
  EVENT_SOURCES[event]=locations;
  EVENT_LABELS[event]=label;
}
for (const [target,label] of Object.entries(STATUS_LEAVES)) {
  for (const actor of ["HUMAN","ASSIGNEE"])
    source(`${actor}_MOVE_${target}`,`${actor === "HUMAN" ? "디렉터가" : "담당이"} ${label}으로 옮긴다`,
      `${control}#setCardStatus/applyStatusTx`,"cards/card_operations.ts#executeCardOperation");
}
const events: [string,string,string[]][] = [
  ["CREATE_TODO","디렉터가 할 일 카드를 만든다",[`${control}#createCardMutation`]],
  ["CREATE_QUEUED","디렉터가 대기열 카드를 만든다",[`${control}#createCardMutation`]],
  ["ASK_OWNER","담당이 질문을 올린다",[`${control}#askQuestion`]],
  ["ASK_OTHER","다른 에이전트가 질문을 올린다 [담당 세션 없음]",[`${control}#askQuestion/assertNotOtherSessionAssignee`]],
  ["ANSWER_DETAIL","디렉터가 마지막 질문에 답한다 [카드 상세]",[`${control}#answerQuestion`]],
  ["ANSWER_BOARD","디렉터가 마지막 질문에 답한다 [감독 판]",["session/persistent_report_service.ts#acceptReply/cardQuestionDecision"]],
  ["WITHDRAW","담당이 마지막 질문을 철회한다",[`${control}#withdrawQuestion`]],
  ["HUMAN_MESSAGE","디렉터가 담당에게 말한다 [말로 풀리는 기다림]",[`${control}#resumeBlockedCardOnHumanInput`,"production.ts#resumeBlockedCardOnHumanInput caller"]],
  ["HUMAN_COMMENT","디렉터가 커멘트를 남긴다 [말로 풀리는 기다림]",[`${control}#applyAddCommentTx`]],
  ["AGENT_COMMENT","담당이 커멘트를 남긴다",[`${control}#applyAddCommentTx`]],
  ["START_ADMITTED_WORK","자동 배정된 첫 작업 세션이 착수한다",[`${control}#startCardWork`,"cards/card_work_lifecycle.ts#acceptQueuedWork"]],
  ["START_WORK","담당이 착수를 확인한다",[`${control}#startCardWork`]],
  ["REQUEST_REVIEW","담당이 검수를 요청한다",[`${control}#requestCardReview`]],
  ["RECORD_EXECUTION","서버가 실행을 확인한다",[`${control}#recordExecution`,"cards/card_execution_service.ts#observeOnce"]],
  ["RECORD_EXECUTION_LATE","서버가 실행을 확인한다 [사람이 이미 상태를 바꿈]",[`${control}#recordExecution`]],
  ["DISPATCH","서버가 대기열 카드를 실행한다",[`${control}#recordDispatch`,"cards/card_dispatcher.ts#dispatchOnce","cards/card_execution_service.ts#execute"]],
  ["ADMIT_DISPATCH","서버가 배정을 허가하고 대기열에 둔다",[`${control}#recordDispatch`,"cards/card_orchestration_coordinator.ts#dispatch","cards/card_orchestration_workers.ts#reconcile/reject"]],
  ["SERVER_SHORT_LIMIT","담당이 짧은 한도로 끝난다",["cards/card_dispatcher.ts#sessionEnded/reconcileTerminal/blockForLimit"]],
  ["SERVER_LONG_LIMIT","담당이 긴 한도로 끝난다",["cards/card_dispatcher.ts#blockForLimit"]],
  ["SERVER_LIVE_RESUME","서버가 이어간다 [담당 세션이 끝나지 않음]",["cards/card_dispatcher.ts#resumeAutoLimitedCard",`${control}#resumeLimitedCard`]],
  ["SERVER_LIMIT_TIME","서버가 깨운다 [짧은 한도가 풀림]",["cards/card_dispatcher.ts#resumeAutoLimitedCard",`${control}#resumeLimitedCard`]],
  ["SERVER_LIMIT_RELAUNCH","서버가 다시 띄운다 [예약 없이 한도가 풀림]",["cards/card_dispatcher.ts#resumeLimits",`${control}#resumeDispatchedCard`]],
  ["SERVER_LIMIT_REQUEUE","서버가 대기열로 돌린다 [담당이 한도 종료가 아님]",["cards/card_dispatcher.ts#resumeLimits"]],
  ["ADMIT_LIMIT","서버가 한도 재배정을 허가한다",[`${control}#resumeDispatchedCard`,"cards/card_orchestration_coordinator.ts#dispatch"]],
  ["WAKE_TIME","서버가 깨운다 [검증 시각이 됨]",["cards/card_dispatcher.ts#wakeAwaitingVerification",`${control}#resumeVerificationCard`]],
  ["WAKE_FAIL","서버가 보고 없이 막는다 [검증 깨우기 실패]",["cards/card_dispatcher.ts#blockVerificationWake"]],
  ["CREATE_FAIL","서버가 보고 없이 막는다 [세션 생성 실패]",["cards/card_dispatcher.ts#dispatchOnce","cards/card_execution_service.ts#sendAndObserve","cards/card_orchestration_workers.ts#reconcile/reject"]],
  ["ATTACHMENT_FAIL","서버가 보고 없이 막는다 [첨부 준비 실패]",["cards/card_dispatcher.ts#resumeLimits/resumeAutoLimitedCard"]],
  ["NOTE_MISSING","서버가 담당 에이전트 없음을 적는다",["cards/card_dispatcher.ts#dispatchOnce",`${control}#noteMissingAssignee`]],
  ["ASSIGN_SESSION","담당을 세션으로 정한다",[`${control}#patchCard/claim`,"cards/card_operations.ts#transfer_card_assignee"]],
  ["ASSIGN_AGENT","시작 전 카드의 담당 에이전트를 정한다",[`${control}#patchCard/saveExecutionSettings`,"cards/card_maintenance_service.ts#updateUnstartedCard"]],
  ["ASSIGN_HUMAN","담당을 사람으로 정한다",[`${control}#patchCard`]],
  ["REPLACE_LIVE","실행 중인 세션으로 담당을 바꾼다",["control_plane/repositories/session_card_replacement.ts#applySessionCardReplacement",`${control}#patchCard`]],
  ["REPLACE_LIMITED","긴 한도로 끝난 세션으로 담당을 바꾼다",[`${control}#patchCard`]],
  ["OWNER_END","담당 세션이 끝난다 [정상 종료]",["cards/card_dispatcher.ts#sessionEnded/reconcileTerminal"]],
  ["PAS_APPEARS","감독 PAS가 생긴다",["session/persistent_report_service.ts#readCardBoardSessions"]],
  ["BOARD_ONE","다른 장이 올라 열한 장이 된다",["session/persistent_report_service.ts#upsertEntry"]],
  ["BOARD_OTHER_REMOVED","다른 장이 내려 열한 장이 된다",["session/persistent_report_service.ts#remove"]],
  ["BOARD_FULL","다른 장이 올라 열두 장이 된다",["session/persistent_report_service.ts#upsertEntry"]],
  ["BOARD_ROOM","다른 장이 내려 열 장 이하가 된다",["session/persistent_report_service.ts#remove"]],
  ["BULK_TODO","디렉터가 여러 장을 할 일로 옮긴다 [담당이 쉬고 있음]",["cards/card_maintenance_service.ts#bulkSetCardStatus","cards/card_maintenance_tx.ts#assertBulkStatusGuardTx"]],
  ["BULK_QUEUED","디렉터가 여러 장을 대기열로 옮긴다 [담당이 쉬고 있음]",["cards/card_maintenance_service.ts#bulkSetCardStatus"]],
  ["BULK_HOLD","디렉터가 여러 장을 보류로 옮긴다 [담당이 쉬고 있음]",["cards/card_maintenance_service.ts#bulkSetCardStatus"]],
  ["BULK_CANCELLED","디렉터가 여러 장을 취소로 옮긴다 [담당이 쉬고 있음]",["cards/card_maintenance_service.ts#bulkSetCardStatus"]],
  ["MERGE_SOURCE","디렉터가 시작 전 카드를 합쳐 취소한다",["cards/card_maintenance_service.ts#mergeCards"]],
];
for (const [event,label,locations] of events) source(event,label,...locations);
export const CARD_EVENTS:CardEvent[] = Object.keys(EVENT_SOURCES).map(type=>({type}));

/** Inventory of every status decision entry point at the baseline commit. */
export const STATUS_DECISIONS:Record<string,string[]> = {
  createCardMutation:["CREATE_TODO","CREATE_QUEUED"],recordExecution:["RECORD_EXECUTION","RECORD_EXECUTION_LATE"],
  setCardStatus:["HUMAN_MOVE_running","ASSIGNEE_MOVE_running"],resumeBlockedCardOnHumanInput:["HUMAN_MESSAGE"],
  requestCardReview:["REQUEST_REVIEW"],startCardWork:["START_WORK","START_ADMITTED_WORK"],askQuestion:["ASK_OWNER","ASK_OTHER"],
  answerQuestion:["ANSWER_DETAIL","ANSWER_BOARD"],withdrawQuestion:["WITHDRAW"],
  recordDispatch:["DISPATCH","ADMIT_DISPATCH"],resumeDispatchedCard:["SERVER_LIMIT_RELAUNCH","ADMIT_LIMIT"],
  resumeLimitedCard:["SERVER_LIVE_RESUME","SERVER_LIMIT_TIME"],resumeVerificationCard:["WAKE_TIME"],
  applyAddCommentTx:["HUMAN_COMMENT","AGENT_COMMENT"],mergeCards:["MERGE_SOURCE"],
  bulkSetCardStatus:["BULK_TODO","BULK_QUEUED","BULK_HOLD","BULK_CANCELLED"],
};

/** Diagram projections of repeated memory writes; state transitions stay unchanged. */
export const MEMORY_CHART_GROUPS:Record<string,{from:string;to:string;label:string}>={
  "memory-question-qOwner":{from:"qNone",to:"qOwner",label:"담당이 질문을 올린다"},
  "memory-question-qOrphan":{from:"qNone",to:"qOrphan",label:"다른 세션이 질문한다 [담당 세션 없음]"},
  "memory-question-qNone":{from:"card.question",to:"qNone",label:"답·철회·사람의 말로 닫는다 [상세와 판의 답 조건은 다름]"},
  "memory-questionEntry-ePresent":{from:"eNone",to:"ePresent",label:"질문을 올리거나 보류에서 돌아옴 [빈자리 있음]"},
  "memory-questionEntry-eNone":{from:"ePresent",to:"eNone",label:"답·철회·카드 내림으로 장을 지운다"},
  "memory-cardEntry-cPresent":{from:"cNone",to:"cPresent",label:"검수·막힘 장을 올린다 [질문 없음, 빈자리 있음]"},
  "memory-cardEntry-cNone":{from:"cPresent",to:"cNone",label:"질문·실행·내려감으로 장을 내린다"},
  "memory-reservation-rLimit":{from:"rNone",to:"rLimit",label:"담당이 짧은 한도로 끝난다"},
  "memory-reservation-rVerify":{from:"rNone",to:"rVerify",label:"검증 시각을 정한다"},
  "memory-reservation-rNone":{from:"rLimit",to:"rNone",label:"담당 교체 또는 한도 막힘을 나가 예약이 없어진다"},
  "memory-assignee-originalLimited":{from:"originalLive",to:"originalLimited",label:"원래 담당이 짧은 한도로 끝난다"},
  "memory-assignee-replacedLive":{from:"originalLimited",to:"replacedLive",label:"살아 있는 새 담당으로 바꾼다"},
  "memory-assignee-replacedLimited":{from:"originalLimited",to:"replacedLimited",label:"긴 한도로 끝난 새 담당으로 바꾼다"},
  "memory-limitedOwner-lSame":{from:"lNone",to:"lSame",label:"짧은 한도로 막힐 때 담당을 기록한다"},
  "memory-limitedOwner-lDifferent":{from:"lSame",to:"lDifferent",label:"담당이 바뀌어 원래 담당과 달라진다"},
  "memory-limitedOwner-lDifferentLong":{from:"lSameLong",to:"lDifferentLong",label:"담당이 바뀌어 원래 담당과 달라진다"},
  "memory-limitedOwner-lNone":{from:"lDifferent",to:"lNone",label:"한도 막힘을 나가 이력을 지운다"},
};
