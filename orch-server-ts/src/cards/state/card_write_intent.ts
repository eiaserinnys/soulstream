/** Symbols contain no user text, timestamps or identities. */
export type CardBinding = {literal:string|boolean|number|null}|{bind:string};
export interface CardWriteStep {kind:'card'|'questionInsert'|'questionUpdate'|'questionAnswer'|'questionWithdraw'|'closeQuestions';fields:Record<string,CardBinding>;spread?:CardBinding}
export type CardWriteIntent=CardWriteStep[];
export const literal=(value:string|boolean|number|null):CardBinding=>({literal:value});
export const bind=(name:string):CardBinding=>({bind:name});
export interface CardBindingValues {
  card:Record<string,unknown>;command:Record<string,unknown>;actor:{kind:string;sessionId:string|null;userId?:string|null};
  now:Date;eventId:number|null;queuePosition?:string;values?:Record<string,unknown>;lazy?:Record<string,()=>unknown>;
}
/** A decode owns one resolver: selected names are computed once, unused names never run. */
export function createCardBindingResolver(values:CardBindingValues):(name:string)=>unknown {
  const bindings:Record<string,unknown>={
    'clock':values.now,'actor.session':values.actor.sessionId,'actor.user':values.actor.userId??null,
    'completion.kind':values.actor.kind==='system'?null:values.actor.kind,'event.id':values.eventId,
    'queue.new':values.queuePosition,
    'command.blockedDetail.nullable':values.command.blockedDetail??null,
    ...values.values,
  };
  for(const [key,value] of Object.entries(values.card))bindings[`card.${key}`]=value;
  for(const [key,value] of Object.entries(values.command))bindings[`command.${key}`]=value;
  const lazy:Record<string,()=>unknown>={
    'command.wakeAt.iso':()=>values.command.wakeAt==null?null:new Date(String(values.command.wakeAt)).toISOString(),
    'command.waitingFor.trimmed':()=>values.command.waitingFor==null?null:String(values.command.waitingFor).trim(),
    'command.reason.trimmed':()=>values.command.reason==null?null:String(values.command.reason).trim(),
    ...values.lazy,
  };
  for(const name of Object.keys(values.lazy??{}))delete bindings[name];
  return name=>{
    if(!Object.hasOwn(bindings,name)&&Object.hasOwn(lazy,name))bindings[name]=lazy[name]!();
    return bindings[name];
  };
}
/** Bind already-selected writes. There is deliberately no status or permission decision here. */
export function decodeCardWriteIntent(intent:CardWriteIntent,values:CardBindingValues,resolve=createCardBindingResolver(values)):Record<string,unknown>[] {
  const value=(v:CardBinding)=>'literal'in v?v.literal:resolve(v.bind);
  return intent.map(step=>({...((step.spread?value(step.spread):{}) as Record<string,unknown>),...Object.fromEntries(Object.entries(step.fields).map(([key,v])=>[key,value(v)]))}));
}
