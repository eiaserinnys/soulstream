import type { CardStatus, CardRow } from '../control_plane/card_types.js';
import type { CardAssigneeInput } from '../control_plane/card_models.js';

export type HumanCardCommand =
  | {type:'CREATE';queue?:boolean;assignee?:CardAssigneeInput|null}
  | {type:'SET_STATUS';status:CardStatus;blockedKind?:CardRow['blocked_kind'];blockedDetail?:string|null;wakeAt?:string;waitingFor?:string}
  | {type:'REQUEST_REVIEW';ask?:string}
  | {type:'HUMAN_INPUT'}
  | {type:'ASK_QUESTION';text:string;options:string[]}
  | {type:'ANSWER_QUESTION';questionId:string;answer:string}
  | {type:'WITHDRAW_QUESTION';questionId:string;reason:string}
  | {type:'ADD_COMMENT';body:string;kind?:'comment'|'spoken';mode?:'spoken'|'reply';itemId?:number;entrance:'direct'|'followup'};
