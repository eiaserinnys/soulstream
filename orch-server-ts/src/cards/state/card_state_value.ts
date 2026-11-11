import type { StateValue } from 'xstate';
export const STATUS_PATHS = {
  uncreated: 'uncreated', todo: {on:{ready:'todo'}}, queued: {on:{ready:{queued:'normal'}}}, missing: {on:{ready:{queued:'missing'}}},
  running:{on:'running'}, question:{on:{talk:'question'}}, noReport:{on:{talk:'noReport'}}, other:{on:{talk:'other'}},
  verification:{on:{talk:'verification'}}, limit:{on:{silent:'limit'}}, review:{on:{silent:'review'}},
  hold:{off:'hold'}, done:{off:'done'}, cancelled:{off:'cancelled'},
} as const;
export type StatusLeaf = keyof typeof STATUS_PATHS;
export type CardStateValue = { status: StateValue; question:'none'|'open'; reservation:'none'|'verify'|'limit'|'longLimit'; assignee:'none'|'agent'|'human'|'session'; archive:'active'|'archived'; verdict:'ready' };
export function rowToStateValue(row:Record<string,any>|null, questions:readonly Record<string,any>[]):CardStateValue {
  const r=row ?? {};
  const leaf:StatusLeaf = !row ? 'uncreated' : r.status==='blocked' ? r.blocked_kind==='question'?'question':r.blocked_kind==='limit'?'limit':r.blocked_kind==='no_report'?'noReport':'other' :
    r.status==='queued' ? r.blocked_detail==='담당 에이전트 없음'?'missing':'queued' : r.status==='awaiting_verification'?'verification':r.status==='on_hold'?'hold':r.status;
  return { status:STATUS_PATHS[leaf], question:questions.some(q=>q.answer===null&&q.withdrawn_at===null)?'open':'none',
    reservation:r.wake_at?'verify':r.limit_resume_session_id?(r.limit_resume_at?'limit':'longLimit'):'none',
    assignee:r.assignee_kind??'none',archive:r.archived?'archived':'active',verdict:'ready' };
}
export function statusLeaf(value:CardStateValue):StatusLeaf {
  return (Object.keys(STATUS_PATHS) as StatusLeaf[]).find(k=>JSON.stringify(STATUS_PATHS[k])===JSON.stringify(value.status))!;
}
export function stateValueToColumns(value:CardStateValue) {
  const leaf=statusLeaf(value);
  const dbStatus:Partial<Record<StatusLeaf,string>>={question:'blocked',noReport:'blocked',other:'blocked',limit:'blocked',verification:'awaiting_verification',hold:'on_hold',missing:'queued'};
  return {status:dbStatus[leaf]??leaf,blocked_kind:leaf==='question'?'question':leaf==='limit'?'limit':leaf==='noReport'?'no_report':null,
    ...(leaf==='missing'?{blocked_detail:'담당 에이전트 없음'}:{}),
    assignee_kind:value.assignee==='none'?null:value.assignee,archived:value.archive==='archived',
    ...(value.reservation!=='verify'?{wake_at:null,waiting_for:null}:{}),
    ...(value.reservation==='none'||value.reservation==='verify'?{limit_resume_session_id:null,limit_resume_at:null}:value.reservation==='longLimit'?{limit_resume_at:null}:{}),
  };
}
