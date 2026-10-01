const fs = require('node:fs');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { SessionDiagnosticsRuntime } = require('../src/lib/session-diagnostics-runtime.ts');
let benchmarkSink = 0;

class MemoryStorage {
  values = new Map();

  async getItem(key) {
    return this.values.get(key) ?? null;
  }

  async setItem(key, value) {
    this.values.set(key, value);
  }
}

function createRuntime(sessionCount) {
  const runtime = new SessionDiagnosticsRuntime({
    storage: new MemoryStorage(),
    native: null,
    observe: {
      logEvent: () => true,
      dispatchEvents: async () => undefined,
    },
    appVersion: 'benchmark',
    buildNumber: '0',
    createId: () => '00000000-0000-4000-8000-000000000001',
    getSessionCounts: () => ({ feedCount: sessionCount, runningCount: sessionCount }),
  });
  runtime.startForegroundSampling = () => undefined;
  runtime.stopForegroundSampling = () => undefined;
  runtime.setAppState('active');
  return runtime;
}

function runSyntheticFlow(sessionCount, runtime) {
  let work = 0;
  for (let session = 0; session < sessionCount; session += 1) {
    for (const state of ['open', 'error', 'close']) {
      work += 1;
      runtime?.recordSseConnection('feed_stream', state);
    }
    for (let index = 0; index < 200; index += 1) {
      const bytes = 128 + (index % 512);
      work += bytes;
      runtime?.recordSseMessage('feed_stream', bytes);
    }
    for (let index = 0; index < 250; index += 1) {
      work += index;
      runtime?.recordStoreUpdate('session');
    }
    for (let index = 0; index < 20; index += 1) {
      const commitDelay = index % 16;
      work += commitDelay;
      runtime?.recordFeedRender(commitDelay);
    }
  }
  return work;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measureScenario(sessionCount) {
  const baselineTimes = [];
  const instrumentedTimes = [];
  const checkpointTimes = [];
  const iterations = 30;
  const warmups = 5;

  for (let iteration = 0; iteration < iterations + warmups; iteration += 1) {
    const baselineStartedAt = performance.now();
    benchmarkSink += runSyntheticFlow(sessionCount, null);
    const baselineMs = performance.now() - baselineStartedAt;

    const runtime = createRuntime(sessionCount);
    await runtime.initialize();
    const instrumentedStartedAt = performance.now();
    benchmarkSink += runSyntheticFlow(sessionCount, runtime);
    const instrumentedMs = performance.now() - instrumentedStartedAt;
    const checkpointStartedAt = performance.now();
    await runtime.checkpoint(true);
    const checkpointMs = performance.now() - checkpointStartedAt;

    if (iteration >= warmups) {
      baselineTimes.push(baselineMs);
      instrumentedTimes.push(instrumentedMs);
      checkpointTimes.push(checkpointMs);
    }
  }

  const baselineMedianMs = median(baselineTimes);
  const instrumentedMedianMs = median(instrumentedTimes);
  const checkpointMedianMs = median(checkpointTimes);
  return {
    sessions: sessionCount,
    syntheticOperationsPerSession: 473,
    baselineMedianMs: Number(baselineMedianMs.toFixed(3)),
    captureMedianMs: Number(instrumentedMedianMs.toFixed(3)),
    captureDeltaMs: Number((instrumentedMedianMs - baselineMedianMs).toFixed(3)),
    checkpointMedianMs: Number(checkpointMedianMs.toFixed(3)),
    capturePlusCheckpointMedianMs: Number((instrumentedMedianMs + checkpointMedianMs).toFixed(3)),
    iterations,
  };
}

async function main() {
  const results = [];
  for (const sessionCount of [1, 5, 10]) {
    results.push(await measureScenario(sessionCount));
  }
  process.stdout.write(`${JSON.stringify({ kind: 'local-synthetic-js-benchmark', checksum: benchmarkSink, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'benchmark failed'}\n`);
  process.exitCode = 1;
});
