import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { rowToStateValue } from '../src/cards/state/card_state_value.js';
import { predictObservation } from './card-decision-fixture-adapter.js';
import { normalizeDecisionObservation, type DecisionObservation } from './card-decision-observation.js';
const records:DecisionObservation[]=JSON.parse(readFileSync(new URL('./fixtures/card-state-observations.json',import.meta.url),'utf8')).observations;
function comparePrediction(r:DecisionObservation,prediction:DecisionObservation,label=r.method){
 const actual=normalizeDecisionObservation(prediction),expected=normalizeDecisionObservation(r);
 for(const key of ['after','afterQuestions','versionDelta','statusTimeChanged'] as const)expect(actual[key],`${label} ${key}`).toEqual(expected[key]);
 expect(actual.result.kind,`${label} result`).toBe(expected.result.kind);
 for(const key of ['statusCode','code','message'] as const)expect(actual.result[key],`${label} ${key}`).toEqual(expected.result[key]);
 if(r.method==='bulkSetCardStatus'){
 const errors=(value:any)=>(value?.results??[]).filter((item:any)=>item.ok===false).map((item:any)=>({card_id:item.card_id,error:item.error}));
 expect(errors(actual.result.value),`${label} per-card errors`).toEqual(errors(expected.result.value));
 }
}
it('predicts all frozen observations from before, evidence, command and actor',()=>{
 for(const [index,r] of records.entries()){
 const prediction=predictObservation(r);
 expect(prediction.decision.next,`${index} ${r.method} next regions`).toEqual(rowToStateValue(prediction.observation.after,prediction.observation.afterQuestions));
 comparePrediction(r,prediction.observation,`${index} ${r.method}`);
 }
 console.log(`matched observations: ${records.length}`);
});
it('detects a deliberately wrong bulk rejection reason',()=>{
 const r=records.find(r=>r.method==='bulkSetCardStatus'&&(r.result.value as any)?.results?.some((item:any)=>item.ok===false))!;
 const prediction=predictObservation(r).observation;
 comparePrediction(r,prediction);
 const broken=structuredClone(prediction);
 (broken.result.value as any).results[0].error='다른 거절 사유';
 expect(()=>comparePrediction(r,broken)).toThrow();
 console.log('bulk rejection reason mutation detected');
});
it('does not use observed after rows to choose predictions',()=>{
 const r=records.find(r=>r.method==='setCardStatus'&&r.command.status==='done')!;
 const changed=structuredClone(r);changed.after!.status='cancelled';
 expect(predictObservation(changed).observation.after).toEqual(predictObservation(r).observation.after);
 expect(normalizeDecisionObservation(predictObservation(changed).observation).after).not.toEqual(normalizeDecisionObservation(changed).after);
});
