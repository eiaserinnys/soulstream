import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.env.SOURCE_ROOT ?? join(moduleDir, '../../..'));
const root = resolve(process.env.VERIFICATION_OUTPUT ?? join(sourceRoot, '.state-verification/runner'));
await mkdir(root, { recursive: true });
const revision = '1f15e59e3747fc5de5e245babf16753cce8a7367';
const registry = await readFile(join(sourceRoot, 'soul-server-ts/src/runner/runner_process_registry.ts'), 'utf8');
const recovery = await readFile(join(sourceRoot, 'soul-server-ts/src/runner/runner_recovery_disposition.ts'), 'utf8');
function section(source, from, to) {
  const begin = source.indexOf(from);
  const end = to === null ? source.length : source.indexOf(to, begin + from.length);
  if (begin < 0 || end < 0) throw new Error(`Extraction marker missing: ${from}`);
  return source.slice(begin, end);
}
const prefixes = `type Task = any; type RunnerRegistration = any; type RunnerRecoveryDisposition = any;
type RecoverableRunnerDisposition = any; type RunnerLifecycleRecord = any; type Logger = any;
async function hydrateRunnerRegistration(...args: any[]): Promise<any> { throw new Error('Unexpected production hydrate call'); }
function prepareRecoveredTask(task: any, registration: any): void { task.preparedByTestStub = registration.registrationId; }
`;
const extracted = prefixes + [
  section(registry, 'export function isTerminalRunnerExecutionState(', '\nexport interface LiveRunnerSessionIdsOptions'),
  section(registry, 'export function classifyRunnerRegistration(', '\n/**\n * Returns the durable runner inventory'),
  section(recovery, 'export function heldExecutionSupersedesRegistration(', '\nexport async function handleRecoveryWithFailureTracking'),
  section(recovery, 'export async function terminalizeReapedRunner(', '\nexport async function terminalizeFailedRunner'),
  section(recovery, 'export async function recoverRunnerByDisposition(', null),
].join('\n');
await mkdir(join(root, 'generated'), { recursive: true });

async function execute(name, moduleText) {
  const modulePath = join(root, 'generated', `${name}.ts`);
  await writeFile(modulePath, moduleText);
  const implementation = await import(pathToFileURL(modulePath).href);
  const report = { name, cases: {}, assertions: 0, failures: [] };
  function check(ok, property, input) {
    report.assertions++;
    if (!ok) report.failures.push({ property, input });
  }
  let cases = 0;
  for (const life of [null, 'running', 'completed', 'failed', 'reaped', 'closed']) {
    for (const alive of [false, true]) for (const retired of [false, true]) {
      for (const age of [0, 9, 10, 11]) {
        cases++;
        const registration = {
          retiredAt: retired ? '2026-01-01T00:00:00Z' : null,
          lifecycle: life ? { execution_state: life, progress_at: '2026-01-01T00:00:00Z' } : null,
          pidAlive: alive, registeredAtMs: 100 - age,
        };
        const actual = implementation.classifyRunnerRegistration(registration, 100, 10);
        // Independent explicit truth table for lifecycle observations.
        const terminalDecision = { completed: ['replay_terminal_dead', 'replay_terminal'], failed: ['replay_terminal_dead', 'replay_terminal'], reaped: ['already_reaped', 'already_reaped'], closed: ['closed', 'closed'] };
        const expected = retired ? 'retired_terminal'
          : life === null ? (alive ? 'adopt_prebootstrap' : age < 10 ? 'wait_for_bootstrap' : 'reap_dead')
          : life === 'running' ? (alive ? 'adopt_running' : 'reap_dead')
          : terminalDecision[life][Number(alive)];
        check(actual === expected, 'classification_truth_table', { life, alive, retired, age, expected, actual });
      }
    }
  }
  report.cases.classification = cases;
  cases = 0;
  for (const hasPromise of [false, true]) for (const hasActivation of [false, true]) {
    for (const active of [false, true]) for (const currentId of ['old', 'new', undefined]) {
      for (const oldAlive of [false, true]) {
        cases++;
        const calls = [];
        const task = {
          executionPromise: hasPromise ? Promise.resolve() : undefined,
          executionActivation: hasActivation ? {} : undefined,
          runner: { dispatcher: { hasActiveExecution: () => active, registrationId: () => currentId } },
        };
        const registration = { registrationId: 'old', pidAlive: oldAlive, config: { sessionId: 's1' } };
        await implementation.terminalizeReapedRunner({
          task, registration, hydrate: async value => value,
          terminate: async () => { calls.push('terminate'); },
          invalidate: async () => { calls.push('invalidate'); },
          retireAttached: async () => { calls.push('retireAttached'); return false; },
          recoverOffline: async (_, value) => { calls.push('recoverOffline'); return value; },
          logger: { info() {} },
        });
        const held = hasPromise || hasActivation || active;
        if (held && currentId === 'new') {
          check(calls.length === 0 && task.runnerTerminalFact === undefined, 'old_cleanup_does_not_touch_new_execution', { hasPromise, hasActivation, active, currentId, oldAlive, calls });
        }
        if (!held) check(calls.includes('recoverOffline'), 'unheld_reaped_registration_can_recover', { hasPromise, hasActivation, active, currentId, oldAlive, calls });
      }
    }
  }
  report.cases.reaped_cleanup = cases;
  cases = 0;
  for (const disposition of ['adopt_prebootstrap', 'adopt_running', 'replay_terminal', 'replay_terminal_dead']) {
    for (const alive of [false, true]) for (const replayed of [false, true]) {
      for (const outcome of [undefined, 'registration_invalidated', 'registration_absent']) {
        cases++;
        const calls = [];
        const task = {};
        const registration = { pidAlive: alive, config: { sessionId: 's1' }, registrationId: 'old' };
        await implementation.recoverRunnerByDisposition({
          disposition, registration, task,
          recoverAdopt: async () => { calls.push('adopt'); return task; },
          recoverOffline: async (reg, value, prepare) => { calls.push('offline'); await prepare(reg); return { task: value, replayed }; },
          terminate: async () => { calls.push('terminate'); return outcome; },
          retireTerminal: async () => { calls.push('retire'); },
          logger: { info() {}, warn() {} },
        });
        check(replayed || !calls.includes('retire'), 'no_retire_without_successful_replay', { disposition, alive, replayed, outcome, calls });
        if (disposition.startsWith('adopt_')) check(calls.join(',') === 'adopt', 'adoption_does_not_retire', { disposition, alive, replayed, outcome, calls });
        if (disposition === 'replay_terminal_dead' && replayed) check(calls.includes('retire'), 'successful_dead_terminal_replay_can_retire', { disposition, alive, replayed, outcome, calls });
      }
    }
  }
  report.cases.recovery_disposition = cases;
  report.passed = report.failures.length === 0;
  return report;
}

function mutate(from, to) {
  if (!extracted.includes(from)) throw new Error(`Mutation site missing: ${from}`);
  return extracted.replace(from, to);
}
const baseline = await execute('baseline', extracted);
const mutants = [
  await execute('mutant_disable_new_owner_guard', mutate('if (heldExecutionSupersedesRegistration(input.task, hydrated)) {', 'if (false) {')),
  await execute('mutant_disable_replay_guard', mutate('if (!recovered.replayed) {', 'if (false) {')),
  await execute('mutant_dead_terminal_as_live', mutate('if (registration.pidAlive) return "replay_terminal";', 'if (true) return "replay_terminal";')),
];
const results = {
  schemaVersion: 1, revision, runtime: process.version,
  method: 'Finite input enumeration executing mechanically extracted original TypeScript function bodies with native Node type stripping. Dependency boundaries use explicit mocks. Mutants edit actual extracted source guard conditions.',
  scope: 'Function-level synchronous observations and awaited dependency results; not concurrent schedules, real process termination, kernel locks, SQL, IPC or end-to-end deployment.',
  sourceHashes: {
    runner_process_registry: createHash('sha256').update(registry).digest('hex'),
    runner_recovery_disposition: createHash('sha256').update(recovery).digest('hex'),
  },
  baseline, mutants,
  expectedOutcome: baseline.passed && mutants.every(x => !x.passed),
};
await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ baseline: { passed: baseline.passed, cases: baseline.cases, assertions: baseline.assertions, failures: baseline.failures.length }, mutants: mutants.map(x => ({ name: x.name, failures: x.failures.length, firstCounterexample: x.failures[0] })), expectedOutcome: results.expectedOutcome }, null, 2));
if (!results.expectedOutcome) process.exitCode = 1;
