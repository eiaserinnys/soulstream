/** Existing boundary error contracts. The selected guard supplies the identifier. */
const STATUS_OWNER='담당 세션만 카드 상태를 바꿀 수 있습니다. 담당이 아니면 내부 에이전트 세션이 transfer_card_assignee로 담당을 맡은 뒤 다시 부르세요. 인계는 담당만 바꾸고 작업을 시작하거나 멈추지 않습니다. 담당 세션이 없는 카드는 내부 에이전트 세션 누구나 todo, queued, on_hold, cancelled로 옮길 수 있습니다.';
const WORK_OWNER='담당 세션만 작업을 시작할 수 있습니다. 담당이 아니면 내부 에이전트 세션이 transfer_card_assignee로 담당을 맡은 뒤 다시 부르세요. 인계는 담당만 바꾸고 작업을 시작하거나 멈추지 않습니다.';
export const CARD_FAILURES:Record<string,{statusCode:number|null;code:string|null;message:string}>={
 statusOwner:{statusCode:403,code:null,message:STATUS_OWNER},
 verificationOwner:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'검증 대기는 담당 세션이 있는 카드만 설정할 수 있습니다'},
 verification_missing:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'검증 대기에는 wake_at과 waiting_for가 필요합니다'},
 verification_empty:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'waiting_for를 한 줄로 적으세요'},
 verification_tooLong:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'waiting_for는 36자까지입니다. 지금 {length}자입니다'},
 verification_invalid:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'wake_at은 오프셋이 있는 ISO 8601 시각이어야 합니다'},
 verification_past:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'wake_at은 지금보다 뒤여야 합니다'},
 verification_tooLate:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'wake_at은 지금부터 7일 이내여야 합니다'},
 reviewAsk:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'사용자가 볼 것을 ask에 한 줄로 적으세요'},
 otherAssignee:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'다른 세션이 담당인 카드입니다. 인계 요약, 질문, 발언 기록은 담당 세션만 씁니다.'},
 edit_missing:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'고칠 질문을 이 카드에서 찾을 수 없습니다. 열린 질문의 question_id인지 확인하세요'},
 edit_answered:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'이미 답한 질문은 고칠 수 없습니다'},
 edit_withdrawn:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'철회된 질문은 고칠 수 없습니다'},
 humanAnswer:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'카드 질문에는 사람만 답할 수 있습니다. 질문을 올린 뒤 이 턴을 끝내고 사용자의 답을 기다리세요.'},
 withdrawnAnswer:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'철회된 질문에는 답할 수 없습니다'},
 openQuestion:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'답할 수 있는 열린 질문을 이 카드에서 찾을 수 없습니다. 이미 답했거나 철회됐을 수 있으니 get_card로 질문을 다시 읽고 question_id를 확인하세요.'},
 withdrawOwner:{statusCode:403,code:null,message:'질문을 올린 세션이나 현재 담당 세션만 질문을 철회할 수 있습니다. 담당 세션에서 다시 부르세요.'},
 withdraw_missing:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'철회할 열린 질문을 이 카드에서 찾을 수 없습니다. get_card로 질문을 다시 읽고 question_id를 확인하세요.'},
 withdraw_answered:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'이미 답이 달린 질문은 철회할 수 없습니다. 답을 확인하고 다음 일을 이어가세요.'},
 withdraw_withdrawn:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'이미 철회된 질문입니다. 새로 물을 것이 있으면 ask_card_question으로 올리세요.'},
 commentTrustedMode:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'mode는 신뢰된 세션만 고를 수 있습니다. 이 호출에서는 mode를 생략하세요.'},
 commentTrustedSpoken:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'spoken 커멘트는 신뢰된 세션만 남길 수 있습니다. 진행은 add_card_note에 적으세요.'},
 commentMode:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'mode를 spoken 또는 reply로 지정하세요'},
 replyOwner:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'담당 세션만 카드 커멘트에 답할 수 있습니다. 담당이 아니면 내부 에이전트 세션이 transfer_card_assignee로 담당을 맡은 뒤 다시 부르세요. 인계는 담당만 바꾸고 작업을 시작하거나 멈추지 않습니다.'},
 replyLength:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'reply은 1200자까지입니다. 지금 {length}자입니다'},
 replyUserInput:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'이미 답했습니다. 진행은 노트에 적으세요(add_card_note)'},
 itemMissing:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'항목을 찾을 수 없습니다'},
 questionMissing:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'질문을 이 카드에서 찾을 수 없습니다'},
 questionWithdrawn:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'철회된 질문에는 글을 남길 수 없습니다'},
 questionItem:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'질문 글타래에는 항목을 함께 줄 수 없습니다'},
 questionSpoken:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'질문 글타래에는 spoken을 쓸 수 없습니다'},
 workOwner:{statusCode:422,code:'INVALID_CARD_WORK',message:WORK_OWNER},
 workExecution:{statusCode:422,code:'INVALID_CARD_WORK',message:'이 세션의 카드 실행 신원이 없거나 낡았거나 자동 배정용 세션이라 작업을 착수할 수 없습니다. 상태만 바꾸려면 set_card_status(running)를 쓰세요.'},
 workAdmission:{statusCode:422,code:'INVALID_CARD_WORK',message:'자동 배정 실행은 담당 세션에 대한 유효한 배정 승인이 있어야 착수할 수 있습니다. get_card로 카드 상태를 확인하고, 상태만 바꾸려면 set_card_status(running)를 쓰세요.'},
 executionMatches:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'실행 세션과 카드 담당이 일치하지 않습니다.'},
 queued:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only queued cards may dispatch'},
 pending:{statusCode:409,code:'CARD_EXECUTION_PENDING',message:'실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요.'},
 policyDisabled:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Orchestration policy is disabled'},
 admissionRequired:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Enabled orchestration requires a fenced decision admission'},
 admission_lockedPolicyDisabled:{statusCode:null,code:null,message:'Orchestration policy is disabled'},
 admission_stale:{statusCode:null,code:null,message:'Stale orchestration admission'},
 admission_capacity:{statusCode:null,code:null,message:'Node capacity is full'},
 admission_missingCapacity:{statusCode:null,code:null,message:'Missing node capacity'},
 admission_ineligible:{statusCode:null,code:null,message:'Card is no longer eligible'},
 limitRunning:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only the current running assignee may enter limit-blocked'},
 limitTermination:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Quota termination changed before the card was blocked'},
 shortReservation:{statusCode:422,code:'INVALID_CARD_REQUEST',message:"Only the current assignee's unchanged due limit reservation may resume"},
 longReservation:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only the recorded current long-limit assignee may resume'},
 verificationReservation:{statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only the currently assigned verification-wait card at this wake time may resume'},
 maintenanceSession:{statusCode:403,code:null,message:'card mutation requires an agent session'},
 bulkHuman:{statusCode:403,code:null,message:'사람이 담당인 카드는 bulk_set_card_status로 바꿀 수 없습니다.'},
 bulkRunning:{statusCode:409,code:'CARD_ASSIGNEE_RUNNING',message:'카드 {label}의 담당이 실행 중입니다. 담당 세션이 지금 턴을 돌고 있습니다. 후속 지시는 dispatch_work로 전하거나 턴이 끝난 뒤 다시 시도하세요.'},
 bulkMissing:{statusCode:409,code:null,message:'담당 세션을 찾을 수 없습니다. 현재 담당을 확인하세요.'},
 bulkRest:{statusCode:403,code:null,message:'담당 세션이 있는 카드는 보류·취소만 가능합니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 unstarted_archived:{statusCode:409,code:'CARD_NOT_UNSTARTED',message:'카드 {label}은 보관됨으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 unstarted_human:{statusCode:409,code:'CARD_NOT_UNSTARTED',message:'카드 {label}은 사람 담당으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 unstarted_session:{statusCode:409,code:'CARD_NOT_UNSTARTED',message:'카드 {label}은 담당 세션 연결됨으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 unstarted_status:{statusCode:409,code:'CARD_NOT_UNSTARTED',message:'카드 {label}은 현재 상태 {status}으로 시작 전 카드가 아닙니다. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 maintenancePending:{statusCode:409,code:'CARD_EXECUTION_PENDING',message:'카드 {label}은 실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요. 후속 지시와 담당 교체는 dispatch_work를 쓰세요.'},
 settingsOwner:{statusCode:409,code:null,message:'담당 세션이 연결된 카드의 설정은 변경할 수 없습니다.'},
 replacementOwner:{statusCode:409,code:null,message:'예약 이후 카드 담당이 바뀌었습니다. 현재 담당을 확인하세요.'},
};
export function formatCardDecisionFailure(failure:{id:string},bindings:Record<string,string|number>={}) {
 const template=CARD_FAILURES[failure.id]!;
 return {...template,message:template.message.replace(/\{(\w+)\}/g,(_,key:string)=>String(bindings[key]))};
}

/** Preserve the bulk boundary: a per-card rejection is returned, not thrown. */
export function formatCardDecisionRejection(command:string,cardId:string,failure:{id:string},bindings:Record<string,string|number>={}) {
 const error=formatCardDecisionFailure(failure,bindings);
 if(command==='BULK_SET_STATUS')return {kind:'noop' as const,value:{results:[{card_id:cardId,ok:false,error:error.message}]},statusCode:null,code:null,message:null};
 return {kind:'error' as const,value:null,...error};
}
