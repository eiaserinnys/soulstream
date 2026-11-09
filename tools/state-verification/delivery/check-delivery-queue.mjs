#!/usr/bin/env node
// Executes the pinned production TypeScript with Node's built-in type erasure.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';

const dir = dirname(fileURLToPath(import.meta.url));
const relativeSource = 'soul-server-ts/src/task/task_intervention_queue.ts';
const sourceRoot = resolve(process.env.SOURCE_ROOT ?? process.argv[2] ?? resolve(dir, '../../..'));
const sourcePath = resolve(sourceRoot, relativeSource);
const outputDir = resolve(process.env.VERIFICATION_OUTPUT ?? resolve(sourceRoot, '.state-verification/delivery'));
await mkdir(outputDir, { recursive: true });
const source = await readFile(sourcePath, 'utf8');
const sha = '1f15e59e3747fc5de5e245babf16753cce8a7367';
const expectedSourceDigest = '7f9a462e92e923c009f1dbd5f4e1229635928b71c601515e476de02083171450';
// Normalize only line endings and trailing newlines; preserve all other source bytes.
const normalizedSource = source.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
const digest = createHash('sha256').update(normalizedSource).digest('hex');
if (digest !== expectedSourceDigest) {
  throw new Error('Covered source differs from the verified snapshot; review the mapping and update the sync commit and digest before running.');
}
const definitions = [
  { id: 'H1', deliveryIntent: 'human_live_steer', source: 'user_message' },
  { id: 'H2', deliveryIntent: 'durable_next_turn', source: 'user_message' },
  { id: 'C', deliveryIntent: 'completion_notification', source: 'completion' },
  { id: 'R', deliveryIntent: 'runtime_followup', source: 'runtime' },
];
const identityModes = ['delivery', 'runner', 'both'];
const props = ['QueueIdentityUnique', 'ReenqueueIsIdempotent', 'DrainConservesMessages', 'RuntimeFollowupIsIsolated', 'QueuePriorityAndStableFifo', 'NonemptyQueueMakesProgress'];

async function loadModule(text, tag) {
  const js = stripTypeScriptTypes(text, { mode: 'strip' });
  return import('data:text/javascript;base64,' + Buffer.from(js + '\n// ' + tag).toString('base64'));
}

function rank(m) { return ['completion_notification', 'runtime_followup'].includes(m.deliveryIntent) ? 1 : 0; }
function ids(q) { return q.map(m => m.id); }
function multiset(q) { return [...q].sort().join(','); }
function stateKey(s) { return JSON.stringify([s.queue, s.counts, s.consumed, s.arrivals]); }
function explain(s) {
  return { queue: [...s.queue], enqueues: Object.fromEntries(definitions.map((m, i) => [m.id, s.counts[i]])), consumed: [...s.consumed] };
}
function nodeTrace(nodes, nodeIndex, action, after, property, detail) {
  const tail = [{ action, after: explain(after) }];
  let i = nodeIndex;
  while (nodes[i].parent !== null) {
    tail.push({ action: nodes[i].action, after: explain(nodes[i].state) });
    i = nodes[i].parent;
  }
  return { property, detail, trace: [{ action: 'Init', after: explain(nodes[0].state) }, ...tail.reverse()] };
}

function explore(api, identityMode) {
  const messages = definitions.map(m => ({
    ...m, text: m.id, user: 'verification',
    ...(identityMode !== 'runner' ? { deliveryId: 'delivery-' + m.id } : {}),
    ...(identityMode !== 'delivery' ? { runnerInterventionId: 'runner-' + m.id } : {}),
  }));
  const byId = Object.fromEntries(messages.map(m => [m.id, m]));
  const initial = { queue: [], counts: [0, 0, 0, 0], consumed: [], arrivals: [] };
  const nodes = [{ state: initial, parent: null, action: null }];
  const seen = new Set([stateKey(initial)]);
  let transitions = 0, maximumQueue = 0;
  function checkQueue(after) {
    if (new Set(after.queue).size !== after.queue.length) return ['QueueIdentityUnique', 'A logical identity occurs more than once in the pending queue.'];
    const expected = after.arrivals.filter(id => after.queue.includes(id)).sort((a, b) => rank(byId[a]) - rank(byId[b]));
    if (JSON.stringify(after.queue) !== JSON.stringify(expected)) return ['QueuePriorityAndStableFifo', 'Queue order is not high-before-low with stable FIFO inside each lane.'];
    return null;
  }
  for (let cursor = 0; cursor < nodes.length; cursor++) {
    const before = nodes[cursor].state;
    const actions = messages.filter((m, i) => before.counts[i] < 2 && !before.consumed.includes(m.id)).map(m => ({ kind: 'enqueue', id: m.id }));
    if (before.queue.length) actions.push({ kind: 'drain' });
    for (const action of actions) {
      const task = { interventionQueue: before.queue.map(id => byId[id]) };
      const after = structuredClone(before);
      let violation;
      let label;
      if (action.kind === 'enqueue') {
        const id = action.id, i = definitions.findIndex(m => m.id === id);
        const alreadyQueued = before.queue.includes(id);
        const position = api.enqueueInterventionOnce(task, byId[id]);
        after.counts[i]++;
        if (!after.arrivals.includes(id)) after.arrivals.push(id);
        after.queue = ids(task.interventionQueue);
        label = 'enqueue ' + id + (alreadyQueued ? ' again' : '');
        if (alreadyQueued && JSON.stringify(after.queue) !== JSON.stringify(before.queue)) violation = ['ReenqueueIsIdempotent', 'Re-enqueue changed a queue that already contained the logical identity.'];
        if (position !== after.queue.indexOf(id) + 1) violation = ['ReenqueueIsIdempotent', 'Returned queue position does not identify the accepted logical message.'];
      } else {
        const batch = api.dequeueNextTurnInterventions(task);
        const returned = ids(batch);
        after.queue = ids(task.interventionQueue);
        after.consumed = [...before.consumed, ...returned].sort();
        label = 'drain => ' + (returned.join('+') || 'empty');
        if (batch.some(m => m.id === 'R') && batch.length !== 1) violation = ['RuntimeFollowupIsIsolated', 'Runtime follow-up shared one model input batch with another logical message.'];
        if (multiset([...returned, ...after.queue]) !== multiset(before.queue)) violation ??= ['DrainConservesMessages', 'Draining lost or duplicated a pending logical identity.'];
        if (before.queue.length && batch.length === 0) violation ??= ['NonemptyQueueMakesProgress', 'A nonempty queue produced an empty batch.'];
      }
      transitions++;
      violation ??= checkQueue(after);
      if (violation) return { pass: false, identityMode, statesVisited: cursor + 1, statesDiscovered: nodes.length, transitions, ...nodeTrace(nodes, cursor, label, after, ...violation) };
      maximumQueue = Math.max(maximumQueue, after.queue.length);
      const key = stateKey(after);
      if (!seen.has(key)) {
        seen.add(key);
        nodes.push({ state: after, parent: cursor, action: label });
      }
    }
  }
  return { pass: true, identityMode, distinctStates: nodes.length, transitions, maximumQueue };
}

const baselineApi = await loadModule(source, 'baseline');
const baseline = identityModes.map(mode => explore(baselineApi, mode));
const mutations = [
  {
    name: 'duplicate-new-enqueue',
    mutate: s => s.replace('task.interventionQueue.push(message);', 'task.interventionQueue.push(message, message);'),
  },
  {
    name: 'remove-identity-deduplication',
    mutate: s => s.replace('if (message.runnerInterventionId) {', 'if (false && message.runnerInterventionId) {').replace('if (message.deliveryId) {', 'if (false && message.deliveryId) {'),
  },
  {
    name: 'lose-retained-runtime-followup',
    mutate: s => s.replace('task.interventionQueue = sorted.filter(isRuntimeFollowup);', 'task.interventionQueue = [];'),
  },
  {
    name: 'mix-runtime-followup-with-ordinary-input',
    mutate: s => s.replace('return ordinary;', 'return sorted;'),
  },
  {
    name: 'reverse-priority',
    mutate: s => s.replace('return lane === "high" ? 0 : 1;', 'return lane === "high" ? 1 : 0;'),
  },
  {
    name: 'never-drain-ordinary-input',
    mutate: s => s.replace('return ordinary;', 'task.interventionQueue = sorted; return [];'),
  },
];
const mutants = [];
for (const mutation of mutations) {
  const changed = mutation.mutate(source);
  if (changed === source) throw new Error('Mutation did not change production source: ' + mutation.name);
  const api = await loadModule(changed, mutation.name);
  const runs = identityModes.map(mode => explore(api, mode));
  mutants.push({ name: mutation.name, detected: runs.every(r => !r.pass), runs });
}
const result = {
  sourceCommit: sha,
  sourceFile: relativeSource,
  sourceSha256: digest,
  runtime: process.version,
  method: 'Breadth-first finite-state exploration using original production functions, not a hand-transcribed implementation',
  bounds: { logicalMessages: 4, maximumEnqueueCallsPerIdentity: 2, identityModes, maximumQueueLength: 4 },
  assumptions: ['No enqueue after a message has been removed for consumption; downstream deduplication and receipts are outside this check.', 'Repeated enqueue carries exactly the same immutable message and identity.', 'Each synchronous function call is one atomic step; no database, network, process crash, or asynchronous engine call is modeled.'],
  properties: props,
  baseline,
  mutants,
  pass: baseline.every(r => r.pass) && mutants.every(m => m.detected),
};
await writeFile(resolve(outputDir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ pass: result.pass, baseline, mutants: mutants.map(m => ({ name: m.name, detected: m.detected, shortestFailure: m.runs[0] })) }, null, 2));
if (!result.pass) process.exitCode = 1;
