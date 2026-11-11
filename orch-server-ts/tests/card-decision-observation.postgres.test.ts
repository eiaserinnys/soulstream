import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { createCardMachineWorld } from './card-machine-world.js';
import { observeCardDecisions, compareDecisionObservation, type DecisionObservation } from './card-decision-observation.js';
import { collectAdditionalObservations } from './card-decision-observation-cases.js';
const baseline = 'c8b9c745a8c8728b65ac2741b75ddb16eec5b7bf';
const fixture = new URL('./fixtures/card-state-observations.json', import.meta.url);
it('collects and replays baseline SQL observations through the same normalized comparator', async () => {
  const world = await createCardMachineWorld();
  const traces = observeCardDecisions(world);
  const { paths } = JSON.parse(await readFile(new URL('./fixtures/card-state-replay-paths.json', import.meta.url), 'utf8')) as { paths: { events: string[] }[] };
  const collect = async () => {
    const observations: DecisionObservation[] = [];
    for (const path of paths) {
      await world.reset(); traces.length = 0;
      for (const event of path.events) await world.apply(event);
      observations.push(...traces);
    }
    traces.length = 0;
    await collectAdditionalObservations(world);
    observations.push(...traces);
    return observations;
  };
  try {
  if (process.env.COLLECT_CARD_OBSERVATIONS === '1') {
    // Pin ALL runtime service code, not only three entry files. Statechart description changes are allowed.
    const changed = execFileSync('git', ['diff', '--name-only', baseline, '--', 'orch-server-ts/src', 'soul-server-ts/src', 'packages'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    expect(changed.filter(p => !p.startsWith('orch-server-ts/src/cards/state/') && p !== 'orch-server-ts/src/oauth/oauth_access.ts')).toEqual([]);
    const previous = JSON.parse(await readFile(fixture, 'utf8'));
    const observations = await collect();
    // Compare before replacing the oracle: new evidence is the only permitted
    // difference in the original prefix. Never rewrite a mismatching baseline.
    expect(previous.observations.length).toBe(327);
    for (const [index, old] of previous.observations.entries()) {
      const enriched = structuredClone(observations[index]!);
      try { compareDecisionObservation(old, enriched); }
      catch (error) { throw new Error(`old baseline mismatch at ${index} (${old.method})`, { cause: error }); }
    }
    console.log('original observations preserved: 327 / 327');
    const enrichmentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      await writeFile(fixture, JSON.stringify({ baseline,
        enrichment: { commit: enrichmentCommit, serviceDifference: 'Compared with c8b9c745a: disconnected cards/state verification/decision modules and oauth_access.ts scope; runtime card services unchanged', preservedObservations: 327, previousEnrichment: previous.enrichment },
        command: 'COLLECT_CARD_OBSERVATIONS=1 NODE_ENV=development pnpm --dir orch-server-ts exec vitest run tests/card-decision-observation.postgres.test.ts --minWorkers=1 --maxWorkers=2 --testTimeout=600000',
        observations }, null, 2) + '\n');
  }
  const expected = JSON.parse(await readFile(fixture, 'utf8'));
  expect(expected.baseline).toBe(baseline);
  expect(expected.observations.length).toBeGreaterThan(0);
  const actual = await collect();
  expect(actual.length).toBe(expected.observations.length);
  for (const [i, r] of expected.observations.entries()) {
    try { compareDecisionObservation(r, actual[i]!); }
    catch (error) { throw new Error(`observation ${i} (${r.method}): ${String(error)}`, { cause: error }); }
  }
  console.log(`observations: ${expected.observations.length}`);
  } finally { await world.cleanup(); }
}, 600000);
