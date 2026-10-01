import {
  SESSION_DIAGNOSTICS_JOURNAL_KEY,
  SESSION_DIAGNOSTICS_OUTBOX_KEY,
  SessionDiagnosticsRuntime,
  type DiagnosticsNativeBridge,
  type DiagnosticsObserve,
  type DiagnosticsStorage,
} from '../session-diagnostics-runtime';

class MemoryStorage implements DiagnosticsStorage {
  readonly values = new Map<string, string>();
  readonly writeKeys: string[] = [];
  failNextSetFor: string | null = null;
  failNextGetFor: string | null = null;

  async getItem(key: string): Promise<string | null> {
    if (this.failNextGetFor === key) {
      this.failNextGetFor = null;
      throw new Error('synthetic storage read failure');
    }
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writeKeys.push(key);
    if (this.failNextSetFor === key) {
      this.failNextSetFor = null;
      throw new Error('synthetic storage failure');
    }
    this.values.set(key, value);
  }
}

class FakeNativeBridge implements DiagnosticsNativeBridge {
  starts = 0;
  stops = 0;
  acknowledged: string[][] = [];
  recordsJson = JSON.stringify({
    processId: '00000000-0000-4000-8000-000000000099',
    droppedCount: 0,
    records: [],
  });

  async readPendingRecords(): Promise<string> {
    return this.recordsJson;
  }

  async acknowledgeRecords(ids: string[]): Promise<boolean> {
    this.acknowledged.push(ids);
    return true;
  }

  startMainThreadProbe(): void {
    this.starts += 1;
  }

  stopMainThreadProbe(): void {
    this.stops += 1;
  }
}

function makeIdFactory(): () => string {
  let sequence = 1;
  return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
}

function createRuntime(
  storage: MemoryStorage,
  observe: DiagnosticsObserve,
  native = new FakeNativeBridge(),
  now: () => number = () => Date.now(),
  monotonicNow?: () => number,
): SessionDiagnosticsRuntime {
  return new SessionDiagnosticsRuntime({
    storage,
    native,
    observe,
    appVersion: '1.0.0',
    buildNumber: '121',
    now,
    monotonicNow,
    createId: makeIdFactory(),
    getFrameRateMetrics: async () => ({
      renderedFrames: 0,
      expectedFrames: 0,
      droppedFrames: 0,
      frozenFrames: 0,
      slowFrames: 0,
      freezeTime: 0,
      sessionDuration: 0,
    }),
    getSessionCounts: () => ({ feedCount: 2, runningCount: 1 }),
  });
}

function createObserve(overrides: Partial<DiagnosticsObserve> = {}): DiagnosticsObserve {
  return {
    logEvent: jest.fn(() => true),
    dispatchEvents: jest.fn(async () => undefined),
    ...overrides,
  };
}

async function savePreviousRun(storage: MemoryStorage): Promise<void> {
  const previous = createRuntime(storage, createObserve());
  await previous.initialize();
  for (let index = 0; index < 128; index += 1) {
    previous.record({
      timestampMs: Date.now(),
      kind: 'operation',
      source: 'async_storage',
      phase: 'begin',
      operationId: index + 1,
      value: 1,
    });
  }
  await previous.checkpoint(true);
}

afterEach(() => {
  jest.useRealTimers();
});

test('inactive/background stops JS probes and native probes without recording a long suspension as a hang', async () => {
  jest.useFakeTimers();
  const storage = new MemoryStorage();
  const native = new FakeNativeBridge();
  const runtime = createRuntime(storage, createObserve(), native);
  runtime.setAppState('active');
  await runtime.initialize();

  jest.advanceTimersByTime(2_500);
  runtime.setAppState('inactive');
  runtime.setAppState('background');
  jest.advanceTimersByTime(60_000);
  await Promise.resolve();

  runtime.setAppState('active');
  jest.advanceTimersByTime(1_100);
  const kinds = runtime.getCurrentSnapshot().map((event) => event.kind);

  expect(native.starts).toBeGreaterThanOrEqual(2);
  expect(native.stops).toBeGreaterThanOrEqual(1);
  expect(kinds).not.toContain('js_loop_bucket');
});

test('JS records inactive and background separately and checkpoints the final async boundary', async () => {
  const storage = new MemoryStorage();
  const runtime = createRuntime(storage, createObserve());
  runtime.setAppState('active');
  await runtime.initialize();
  runtime.setAppState('inactive');
  runtime.setAppState('background');
  await runtime.checkpoint(true);

  const journal = JSON.parse(storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY) ?? '{}');
  const states = journal.events
    .filter((event: { kind: string }) => event.kind === 'lifecycle')
    .map((event: { state: string }) => event.state);
  expect(states).toContain('inactive');
  expect(states).toContain('background');
});

test('a long timer gap with a stale active state is treated as ambiguous suspension, not a JS hang', async () => {
  jest.useFakeTimers();
  let nowMs = 0;
  let monotonicNowMs = 0;
  const runtime = createRuntime(
    new MemoryStorage(),
    createObserve(),
    new FakeNativeBridge(),
    () => nowMs,
    () => monotonicNowMs,
  );
  runtime.setAppState('active');
  await runtime.initialize();

  jest.advanceTimersByTime(1_000);
  nowMs = 12_000;
  monotonicNowMs = 12_000;
  jest.advanceTimersByTime(1_000);

  expect(runtime.getCurrentSnapshot().map((event) => event.kind)).not.toContain('js_loop_bucket');
});

test('a failed checkpoint leaves the previous completed journal intact', async () => {
  const storage = new MemoryStorage();
  const runtime = createRuntime(storage, createObserve());
  await runtime.initialize();
  runtime.recordRoute('feed');
  await runtime.checkpoint(true);
  const completedJournal = storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY);

  runtime.recordRoute('chat');
  storage.failNextSetFor = SESSION_DIAGNOSTICS_JOURNAL_KEY;
  await expect(runtime.checkpoint(true)).resolves.toBe(false);

  expect(storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY)).toBe(completedJournal);
});

test('SDK dispatch settlement retains the outbox and a restart retries stable report chunks', async () => {
  const storage = new MemoryStorage();
  await savePreviousRun(storage);
  const firstObserve = createObserve();
  const firstRetry = createRuntime(storage, firstObserve);
  await firstRetry.initialize();
  await firstRetry.dispatchPendingReports();

  const firstBodies = (firstObserve.logEvent as jest.Mock).mock.calls.map((call) => call[1]);
  const firstReport = firstRetry.getPendingReports()[0];
  expect(firstReport.status).toBe('sdk_call_finished_unconfirmed');
  expect(firstReport.attemptCount).toBe(1);
  expect(JSON.stringify(firstBodies)).toContain(firstReport.reportId);
  expect(JSON.parse(storage.values.get(SESSION_DIAGNOSTICS_OUTBOX_KEY) ?? '{}').reports).toHaveLength(1);

  const secondObserve = createObserve();
  const secondRetry = createRuntime(storage, secondObserve);
  await secondRetry.initialize();
  await secondRetry.dispatchPendingReports();

  const secondBodies = (secondObserve.logEvent as jest.Mock).mock.calls
    .map((call) => call[1])
    .filter((body: string) => JSON.parse(body).report_id === firstReport.reportId);
  expect(secondRetry.getPendingReports()[0]).toMatchObject({
    reportId: firstReport.reportId,
    attemptCount: 2,
    status: 'sdk_call_finished_unconfirmed',
  });
  expect(secondBodies).toEqual(firstBodies);
});

test('partial SDK enqueue or dispatch failure remains pending for bounded replay', async () => {
  const storage = new MemoryStorage();
  await savePreviousRun(storage);
  let calls = 0;
  const failedObserve = createObserve({
    logEvent: jest.fn(() => {
      calls += 1;
      return calls === 1;
    }),
    dispatchEvents: jest.fn(async () => {
      throw new Error('synthetic network failure');
    }),
  });
  const firstRetry = createRuntime(storage, failedObserve);
  await firstRetry.initialize();
  await firstRetry.dispatchPendingReports();
  const firstReport = firstRetry.getPendingReports()[0];
  expect(firstReport).toMatchObject({
    attemptCount: 1,
    status: 'sdk_call_finished_unconfirmed',
    lastDispatchFailed: true,
  });
  expect(calls).toBe(2);

  const recoveredObserve = createObserve();
  const recovered = createRuntime(storage, recoveredObserve);
  await recovered.initialize();
  await recovered.dispatchPendingReports();

  const bodies = (recoveredObserve.logEvent as jest.Mock).mock.calls
    .map((call) => call[1])
    .filter((body: string) => JSON.parse(body).report_id === firstReport.reportId);
  expect(recovered.getPendingReports()[0]).toMatchObject({
    reportId: firstReport.reportId,
    attemptCount: 2,
    lastDispatchFailed: false,
  });
  expect(bodies).toHaveLength(firstReport.chunks.length);
  expect(bodies.map((body) => JSON.parse(body).report_id)).toEqual(
    Array(firstReport.chunks.length).fill(firstReport.reportId),
  );
});

test('SSE lifecycle and message counters share one bounded source bucket', async () => {
  const storage = new MemoryStorage();
  const runtime = createRuntime(storage, createObserve());
  await runtime.initialize();
  runtime.setAppState('active');

  runtime.recordSseConnection('feed_stream', 'open');
  runtime.recordSseConnection('feed_stream', 'close');
  runtime.recordSseConnection('feed_stream', 'error');
  runtime.recordSseMessage('feed_stream', 57);
  runtime.setAppState('inactive');
  await runtime.checkpoint(true);

  const journal = JSON.parse(storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY) ?? '{}');
  const bucket = journal.events.find((event: any) => event.kind === 'sse_bucket');
  expect(bucket).toMatchObject({
    source: 'feed_stream',
    count: 1,
    bytes: 57,
    sseOpenCount: 1,
    sseCloseCount: 1,
    sseErrorCount: 1,
  });
  expect(JSON.stringify(bucket)).not.toMatch(/url|token|eventData/);
});

test('native lifecycle records are acknowledged only after both report and journal writes complete', async () => {
  const storage = new MemoryStorage();
  const native = new FakeNativeBridge();
  native.recordsJson = JSON.stringify({
    processId: '00000000-0000-4000-8000-000000000099',
    droppedCount: 0,
    records: [{
      id: '00000000-0000-4000-8000-000000000098',
      processId: '00000000-0000-4000-8000-000000000097',
      timestampMs: Date.now(),
      kind: 'lifecycle',
      source: 'native_lifecycle',
      phase: 'begin',
      state: 'will_resign_active',
      platform: 'native',
    }],
  });
  storage.failNextSetFor = SESSION_DIAGNOSTICS_JOURNAL_KEY;
  const runtime = createRuntime(storage, createObserve(), native);

  await expect(runtime.initialize()).resolves.toBe(false);

  expect(storage.values.has(SESSION_DIAGNOSTICS_OUTBOX_KEY)).toBe(true);
  expect(native.acknowledged).toEqual([]);
});

test('a diagnostics storage read failure preserves the prior journal and outbox without native ACK', async () => {
  const storage = new MemoryStorage();
  await savePreviousRun(storage);
  const previousJournal = storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY);
  const previousOutbox = storage.values.get(SESSION_DIAGNOSTICS_OUTBOX_KEY);
  const native = new FakeNativeBridge();
  native.recordsJson = JSON.stringify({
    processId: '00000000-0000-4000-8000-000000000099',
    droppedCount: 0,
    records: [{
      id: '00000000-0000-4000-8000-000000000098',
      processId: '00000000-0000-4000-8000-000000000097',
      timestampMs: Date.now(),
      kind: 'lifecycle',
      source: 'native_lifecycle',
      phase: 'begin',
      state: 'will_resign_active',
      platform: 'native',
    }],
  });
  storage.writeKeys.length = 0;
  storage.failNextGetFor = SESSION_DIAGNOSTICS_OUTBOX_KEY;
  const runtime = createRuntime(storage, createObserve(), native);

  await expect(runtime.initialize()).resolves.toBe(false);

  expect(storage.values.get(SESSION_DIAGNOSTICS_JOURNAL_KEY)).toBe(previousJournal);
  expect(storage.values.get(SESSION_DIAGNOSTICS_OUTBOX_KEY)).toBe(previousOutbox);
  expect(storage.writeKeys).toEqual([]);
  expect(native.acknowledged).toEqual([]);

  await expect(runtime.initialize()).resolves.toBe(true);
  expect(native.acknowledged).toEqual([['00000000-0000-4000-8000-000000000098']]);
});

test('native ACK names only the read snapshot and leaves records appended before ACK pending', async () => {
  const storage = new MemoryStorage();
  const native = new FakeNativeBridge();
  const priorRecord = {
    id: '00000000-0000-4000-8000-000000000098',
    processId: '00000000-0000-4000-8000-000000000097',
    timestampMs: Date.now(),
    kind: 'lifecycle',
    source: 'native_lifecycle',
    phase: 'begin',
    state: 'will_resign_active',
    platform: 'native',
  };
  native.recordsJson = JSON.stringify({
    processId: '00000000-0000-4000-8000-000000000099',
    droppedCount: 0,
    records: [priorRecord],
  });
  const setItem = storage.setItem.bind(storage);
  const writeOrder: string[] = [];
  storage.setItem = async (key, value) => {
    writeOrder.push(key);
    await setItem(key, value);
  };
  native.acknowledgeRecords = async (ids) => {
    writeOrder.push('native-ack');
    expect(storage.values.has(SESSION_DIAGNOSTICS_OUTBOX_KEY)).toBe(true);
    expect(storage.values.has(SESSION_DIAGNOSTICS_JOURNAL_KEY)).toBe(true);

    const current = JSON.parse(native.recordsJson);
    current.records.push({
      ...priorRecord,
      id: '00000000-0000-4000-8000-000000000096',
      processId: current.processId,
      state: 'did_enter_background',
    });
    current.records = current.records.filter((record: { id: string }) => !ids.includes(record.id));
    native.recordsJson = JSON.stringify(current);
    native.acknowledged.push(ids);
    return true;
  };

  const runtime = createRuntime(storage, createObserve(), native);
  await expect(runtime.initialize()).resolves.toBe(true);

  expect(native.acknowledged).toEqual([[priorRecord.id]]);
  expect(writeOrder.indexOf('native-ack')).toBeGreaterThan(
    writeOrder.indexOf(SESSION_DIAGNOSTICS_JOURNAL_KEY),
  );
  expect(JSON.parse(native.recordsJson).records).toMatchObject([{
    id: '00000000-0000-4000-8000-000000000096',
    processId: '00000000-0000-4000-8000-000000000099',
  }]);
});

test('internal verification records a safe prior-run event once and leaves remote confirmation to Observe query', async () => {
  const storage = new MemoryStorage();
  const firstRun = createRuntime(storage, createObserve());
  await firstRun.initialize();
  await expect(firstRun.recordInternalVerification(true)).resolves.toBe(true);
  await expect(firstRun.recordInternalVerification(true)).resolves.toBe(false);

  const observe = createObserve();
  const nextRun = createRuntime(storage, observe);
  await nextRun.initialize();
  await nextRun.dispatchPendingReports();

  const payloads = (observe.logEvent as jest.Mock).mock.calls.map((call) => JSON.parse(call[1]));
  expect(payloads.some((payload) => payload.prior_run_exit === 'unknown')).toBe(true);
  expect(payloads.flatMap((payload) => payload.events).some((event) => event.kind === 'verification')).toBe(true);
  expect(JSON.stringify(payloads)).not.toMatch(/synthetic|crash|fatal|title|token/i);
});
