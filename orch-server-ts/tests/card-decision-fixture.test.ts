import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { rowToStateValue } from '../src/cards/state/card_state_value.js';
import { predictObservation } from './card-decision-fixture-adapter.js';
import { normalizeDecisionObservation, type DecisionObservation } from './card-decision-observation.js';
const records:DecisionObservation[]=JSON.parse(readFileSync(new URL('./fixtures/card-state-observations.json',import.meta.url),'utf8')).observations;
it('predicts all frozen observations from before, evidence, command and actor',()=>{
 for(const [index,r] of records.entries()){
 const prediction=predictObservation(r);
 expect(prediction.decision.next,`${index} ${r.method} next regions`).toEqual(rowToStateValue(prediction.observation.after,prediction.observation.afterQuestions));
 const actual=normalizeDecisionObservation(prediction.observation),expected=normalizeDecisionObservation(r);
 for(const key of ['after','afterQuestions','versionDelta','statusTimeChanged'] as const)expect(actual[key],`${index} ${r.method} ${key}`).toEqual(expected[key]);
 expect(actual.result.kind,`${index} ${r.method} result`).toBe(expected.result.kind);
 if(expected.result.kind==='error')for(const key of ['statusCode','code','message'] as const)expect(actual.result[key],`${index} ${r.method} ${key}`).toEqual(expected.result[key]);
 }
 console.log(`matched observations: ${records.length}`);
});

it('does not use observed after rows to choose predictions',()=>{
 const r=records.find(r=>r.method==='setCardStatus'&&r.command.status==='done')!;
 const changed=structuredClone(r);changed.after!.status='cancelled';
 expect(predictObservation(changed).observation.after).toEqual(predictObservation(r).observation.after);
 expect(normalizeDecisionObservation(predictObservation(changed).observation).after).not.toEqual(normalizeDecisionObservation(changed).after);
});
