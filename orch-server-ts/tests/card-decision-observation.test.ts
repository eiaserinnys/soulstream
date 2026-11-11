import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compareDecisionObservation, type DecisionObservation } from './card-decision-observation.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/card-state-observations.json', import.meta.url), 'utf8'));
it('records raw inputs and complete result envelopes without derived facts', () => {
  for (const r of fixture.observations) {
    expect(r).not.toHaveProperty('facts');
    expect(r).toHaveProperty('evidence');
    expect(r.actor).toHaveProperty('isAuthor');
    expect(r.result).toHaveProperty('value');
    for (const key of ['statusCode', 'code', 'message']) expect(r.result).toHaveProperty(key);
  }
});
it.each(['before', 'after', 'beforeQuestions', 'afterQuestions', 'versionDelta', 'statusTimeChanged', 'result', 'command', 'actor', 'evidence'])(
  'detects a corrupted %s observation', key => {
    const r: DecisionObservation = fixture.observations[0];
    const broken = { ...structuredClone(r), [key]: 'corrupted' };
    expect(() => compareDecisionObservation(r, broken as unknown as DecisionObservation)).toThrow();
  });
it.each(['kind', 'value', 'statusCode', 'code', 'message'])('detects a corrupted result.%s', key => {
  const r: DecisionObservation = fixture.observations[0];
  const broken = structuredClone(r);
  (broken.result as unknown as Record<string, unknown>)[key] = 'corrupted';
  expect(() => compareDecisionObservation(r, broken)).toThrow();
});

it('normalizes generated identities and clocks while preserving writes and noop returns', () => {
  const r: DecisionObservation = {
    method: 'setCardStatus', command: { cardId: '11111111-1111-1111-1111-111111111111', status: 'done' }, checkedAt: 100,
    actor: { kind: 'agent', sessionId: 'first', userId: null, isAssignee: true, isAuthor: false }, evidence: {},
    before: { id: '11111111-1111-1111-1111-111111111111', status: 'done', assignee_session_id: 'first', completed_at: '2026-01-01T00:00:00Z', queue_position_key: 'A' },
    after: { id: '11111111-1111-1111-1111-111111111111', status: 'done', assignee_session_id: 'first', completed_at: '2026-01-02T00:00:00Z', queue_position_key: 'B' },
    beforeQuestions: [], afterQuestions: [], versionDelta: 1, statusTimeChanged: false,
    result: { kind: 'success', value: true, statusCode: null, code: null, message: null },
  };
  const replay = JSON.parse(JSON.stringify(r).replaceAll('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222').replaceAll('first', 'second').replaceAll('2026-01', '2026-02').replaceAll('"A"', '"X"').replaceAll('"B"', '"Y"'));
  compareDecisionObservation(r, replay);
  replay.after.completed_at = replay.before.completed_at;
  expect(() => compareDecisionObservation(r, replay)).toThrow();
  const noop = structuredClone(r); noop.result.value = false;
  expect(() => compareDecisionObservation(r, noop)).toThrow();
});
