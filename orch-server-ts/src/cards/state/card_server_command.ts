import type { CardWorkExecution } from '../card_work_lifecycle.js';
import type { PolicyAdmission } from '../card_control_plane_service.js';

export type ServerCardCommand =
 | {type:'START_WORK';execution:CardWorkExecution}
 | {type:'CONFIRM_EXECUTION';requestId:string;sessionId:string;execution?:CardWorkExecution}
 | {type:'DISPATCH';sessionId:string;nodeId:string;expectedVersion:number;admission?:PolicyAdmission}
 | {type:'RESUME_LONG_LIMIT';sessionId:string;nodeId?:string;expectedVersion:number;admission?:PolicyAdmission}
 | {type:'BLOCK_FOR_LIMIT';sessionId:string;terminationEventId:number|null}
 | {type:'RESUME_SHORT_LIMIT';sessionId:string;resumeAt:string;now:number}
 | {type:'RESUME_VERIFICATION';sessionId:string;wakeAt:string}
 | {type:'NOTE_MISSING'};

/** Ordered SQL boundaries; the verdict transitions decide whether each is needed. */
export const CARD_SERVER_EVIDENCE_STAGES = {
 START_WORK:['execution','workAdmission','claim'],
 CONFIRM_EXECUTION:['executionSession','executionStatus'],
 DISPATCH:['pending','policy','admission'],
 RESUME_LONG_LIMIT:['pending','policy','admission'],
 BLOCK_FOR_LIMIT:['termination','limitReset'],
 RESUME_SHORT_LIMIT:['pending'],
 RESUME_VERIFICATION:[],NOTE_MISSING:[],
} as const;
export type ServerEvidenceStage = 'ownerState' | typeof CARD_SERVER_EVIDENCE_STAGES[keyof typeof CARD_SERVER_EVIDENCE_STAGES][number];
export const SERVER_EVIDENCE_LABELS:Record<ServerEvidenceStage,string>={
 ownerState:'담당 세션 상태',execution:'실행 등록',workAdmission:'자동 실행 영수증과 허가',claim:'담당 후보',executionSession:'실행 세션',executionStatus:'실행 뒤 상태 변경',
 pending:'미확인 실행 요청',policy:'정책 설정',admission:'허가 fence',termination:'현재 한도 종료',limitReset:'한도 해제 시각',
};
export const admissionResults=['ok','lockedPolicyDisabled','stale','capacity','missingCapacity','ineligible'] as const;
export type AdmissionResult=typeof admissionResults[number];
