import { describe, expect, it, vi } from 'vitest';
import { CardControlPlaneService } from '../src/cards/card_control_plane_service.js';
import type { CardMutationParams } from '../src/cards/card_control_plane_service.js';
import type { CardRow, RepositorySql } from '../src/cards/control_plane/card_types.js';
import type { FolderMutateParams } from '../src/cards/control_plane/card_mutation_core.js';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { bind, decodeCardWriteIntent } from '../src/cards/state/card_write_intent.js';

// Same DB-free public-method/transaction-callback pattern as the baseline probe.
// The real mutateCard still performs its row lock and expectedVersion check.
function harness() {
  let row={id:'card',folder_id:'folder',version:2,status:'running',archived:false,items:[],now:null,
    assignee_kind:'session',assignee_session_id:'owner',queue_position_key:null} as unknown as CardRow;
  const sql=Object.assign(async(strings:TemplateStringsArray)=>strings.join('').includes('SELECT * FROM cards')?[structuredClone(row)]:[],
    {json:(value:unknown)=>value}) as unknown as RepositorySql;
  const service=Object.create(CardControlPlaneService.prototype) as CardControlPlaneService;
  Object.assign(service,{
    repo:{getCard:async()=>structuredClone(row)},repoSql:sql,
    core:{mutate:async(params:FolderMutateParams)=>{
      await params.apply(sql,1);
      return {operation:{payload_json:params.payload},idempotent:false};
    }},
    patch:async(_sql:unknown,_row:unknown,fields:Record<string,unknown>)=>{row={...row,...fields,version:row.version+1} as CardRow;},
  });
  return {service,row:()=>row};
}
const human:CardMutationParams={cardId:'card',actorKind:'user',actorSessionId:null};
const other:CardMutationParams={cardId:'card',actorKind:'agent',actorSessionId:'other'};
const wakeAt=()=>new Date(Date.now()+3600000).toISOString();
const identifier='식별자는 노트에 적으세요(add_card_note). 링크는 증거에 다세요';
const owner='Only the current assignee session may change card status. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work. A card without an assignee session can be moved to todo, queued, on_hold or cancelled by any internal agent session.';

describe('baseline a564fb0 formatter/validation order',()=>{
  it('returns owner 403 before formatting another agent verification reason',async()=>{
    await expect(harness().service.setCardStatus({...other,status:'awaiting_verification',waitingFor:'file.ts',wakeAt:wakeAt()}))
      .rejects.toMatchObject({statusCode:403,message:owner});
  });
  it('returns the 36-character waiting_for error before the 60-character now error',async()=>{
    await expect(harness().service.setCardStatus({...human,status:'awaiting_verification',waitingFor:'가'.repeat(100),wakeAt:wakeAt()}))
      .rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message:'waiting_for는 36자까지입니다. 지금 100자입니다'});
  });
  it('does not format verification inputs when the selected target is done',async()=>{
    const h=harness();
    await h.service.setCardStatus({...human,status:'done',waitingFor:'file.ts',wakeAt:wakeAt()});
    expect(h.row().status).toBe('done');
  });
  it('still validates selected verification now text after permission succeeds',async()=>{
    await expect(harness().service.setCardStatus({...human,status:'awaiting_verification',waitingFor:'file.ts',wakeAt:wakeAt()}))
      .rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message:identifier});
  });
  it.each([
    ['file.ts',identifier],
    ['가'.repeat(100),'ask은 60자까지입니다. 지금 100자입니다'],
  ])('validates review ask %s before another agent permission',async(ask,message)=>{
    await expect(harness().service.requestCardReview({...other,ask}))
      .rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message});
  });
  it('keeps the version fence before review ask validation',async()=>{
    await expect(harness().service.requestCardReview({...other,expectedVersion:1,ask:'file.ts'}))
      .rejects.toMatchObject({statusCode:409,message:'folder card version conflict: card expected version 1, actual version 2'});
  });
  it('keeps wake_at format validation at the original pre-transaction boundary',async()=>{
    await expect(harness().service.setCardStatus({...human,expectedVersion:1,status:'done',wakeAt:'invalid'}))
      .rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message:'wake_at은 오프셋이 있는 ISO 8601 시각이어야 합니다'});
  });
  it('preserves question permission before text formatting and accepts identifier text for its owner',async()=>{
    const h=harness();
    await expect(h.service.askQuestion({...other,text:'file.ts',options:['진행']}))
      .rejects.toMatchObject({statusCode:422,code:'INVALID_CARD_REQUEST',message:'다른 세션이 담당인 카드입니다. 인계 요약, 질문, 발언 기록은 담당 세션만 씁니다.'});
    await h.service.askQuestion({...other,actorSessionId:'owner',text:'file.ts',options:['진행']});
    expect(h.row()).toMatchObject({status:'blocked',blocked_kind:'question'});
  });
});

describe('selected symbolic binding evaluation',()=>{
  it('evaluates only selected binding names, including derived command clocks',()=>{
    const row=harness().row(),actor={kind:'user',sessionId:null};
    const command={type:'SET_STATUS' as const,status:'done' as const,wakeAt:'invalid'};
    const lazy=Object.fromEntries(['formatted.verification','formatted.review','formatted.question','formatted.items'].map(name=>[name,vi.fn(()=>{throw Error(name);})]));
    const result=decideCardTransition(row,[],{},command,actor,Date.now());
    expect(decodeCardDecision(result,{card:row,command,actor,now:new Date(),eventId:1,lazy})[0]!.fields.status).toBe('done');
    Object.values(lazy).forEach(compute=>expect(compute).not.toHaveBeenCalled());
  });
  it('binds a selected lazy value once and reuses its checked result',()=>{
    const compute=vi.fn(()=>42);
    const [write]=decodeCardWriteIntent([{kind:'card',fields:{a:bind('selected'),b:bind('selected')}}],
      {card:{},command:{},actor:{kind:'user',sessionId:null},now:new Date(),eventId:null,lazy:{selected:compute}});
    expect(write).toEqual({a:42,b:42});
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
