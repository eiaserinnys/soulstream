import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeDecisionObservation, type DecisionObservation } from './card-decision-observation.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/card-state-observations.json', import.meta.url), 'utf8'));
function inputKey(r: DecisionObservation) {
  const { before, beforeQuestions, evidence, command, actor } = normalizeDecisionObservation(r);
  const read = r.evidence.decisionReads as any;
  const relation = (clock: number, value: unknown) => value == null ? null : Math.sign(clock - new Date(String(value)).getTime());
  const checkedAt = [r.before?.wake_at, r.before?.limit_resume_at, r.command.wakeAt, read?.admissionRun?.lease_expires_at].map(t => relation(r.checkedAt, t));
  return JSON.stringify({ method: r.method, before, beforeQuestions, evidence, command, actor, checkedAt,
    resumeDue: relation(Number(r.command.now), r.before?.limit_resume_at) });
}
function assertDeterministic(records: DecisionObservation[]) {
  const outcomes = new Map<string, unknown>();
  for (const r of records) {
    const key = inputKey(r);
    const normalized = normalizeDecisionObservation(r);
    const outcome = { result: normalized.result, after: normalized.after, afterQuestions: normalized.afterQuestions,
      versionDelta: normalized.versionDelta, statusTimeChanged: normalized.statusTimeChanged };
    if (outcomes.has(key)) expect(outcome, r.method).toEqual(outcomes.get(key));
    outcomes.set(key, outcome);
  }
}
it('records the admission policy and boundary reads for every frozen input', () => {
  for (const r of fixture.observations) {
    expect(r.evidence).toHaveProperty('decisionReads.orchestrationPolicy');
    expect(r.evidence).toHaveProperty('decisionReads.admissionRun');
    expect(r.evidence).toHaveProperty('decisionReads.sessions');
  }
});
it('has no equal normalized decision inputs with different observed results', () => {
  assertDeterministic(fixture.observations);
});
it('detects a conflicting result for identical decision input', () => {
  const r = structuredClone(fixture.observations[0]);
  const changed = structuredClone(r);
  changed.result = { kind: 'error', value: null, statusCode: 422, code: 'INVALID_CARD_REQUEST', message: 'conflicting result' };
  expect(() => assertDeterministic([r, changed])).toThrow();
});
