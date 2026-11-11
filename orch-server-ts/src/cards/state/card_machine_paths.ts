import { cardMachine, type CardSnapshot } from "./card_machine.js";
import { checkCardPromises } from "./card_machine_promises.js";
import type { CardEvent } from "./card_machine_events.js";

/** Identity of a selected definition branch, not of a state-pair in the graph. */
export function transitionIds(state:CardSnapshot,event:CardEvent):string[] {
  return cardMachine.getTransitionData(state,event).map(t=>{
    const branch=t.source.on[event.type]?.indexOf(t)??-1;
    return `${t.source.id}:${event.type}:${branch}`;
  });
}
export function cardContrastPaths() {
  const result=checkCardPromises();
  const sourcePaths=new Map(result.paths.map(p=>[JSON.stringify(p.state.value),p.steps.map(s=>s.event.type).filter(e=>e!=="xstate.init")]));
  const selected=new Map<string,{events:string[];definitions:string[]}>();
  const covered=new Set<string>();
  for(const a of Object.values(result.adjacency))for(const edge of Object.values(a.transitions)) {
    const ids=transitionIds(a.state,edge.event);
    if(!ids.some(id=>!covered.has(id)))continue;
    const events=[...sourcePaths.get(JSON.stringify(a.state.value))!,edge.event.type];
    const key=events.join("\n");
    selected.set(key,{events,definitions:ids});ids.forEach(id=>covered.add(id));
  }
  return {paths:[...selected.values()],definitions:[...covered]};
}
