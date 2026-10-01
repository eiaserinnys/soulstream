import {
  BoundedDiagnosticsJournal,
  createReportChunks,
  markSdkCallFinishedUnconfirmed,
  normalizeDiagnosticEvent,
  prepareReportDispatch,
  reopenReportsAfterRestart,
  retainPendingReports,
  SESSION_DIAGNOSTICS_LIMITS,
  utf8ByteLength,
  type DiagnosticEvent,
  type DiagnosticSource,
  type ModalDiagnosticSource,
  type PendingDiagnosticReport,
} from './session-diagnostics-core';

export const SESSION_DIAGNOSTICS_JOURNAL_KEY = '@soul-app/session-diagnostics-journal-v1';
export const SESSION_DIAGNOSTICS_OUTBOX_KEY = '@soul-app/session-diagnostics-outbox-v1';
export const SESSION_DIAGNOSTICS_VERIFY_KEY = '@soul-app/session-diagnostics-verification-v1';
export const SESSION_DIAGNOSTICS_EVENT_NAME = 'soul-app.diagnostics.chunk';

const MAX_JOURNAL_STORAGE_BYTES = 40 * 1024;
const MAX_OUTBOX_STORAGE_BYTES = 256 * 1024;
const MAX_NATIVE_RECORDS_IN_ENVELOPE = 64;
const MAX_REMEMBERED_NATIVE_IDS = 192;
const JS_PROBE_INTERVAL_MS = 1_000;
const JS_EVENT_LOOP_DELAY_THRESHOLD_MS = 50;
const JS_AMBIGUOUS_SUSPENSION_GAP_MS = 10_000;

export type DiagnosticsAppState = 'active' | 'inactive' | 'background' | 'unknown';

export interface DiagnosticOperation {
  id: number;
  startedAtMs: number;
  startedAtMonotonicMs: number;
}

export interface DiagnosticsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface DiagnosticsObserve {
  logEvent(name: string, body: string): boolean;
  dispatchEvents(): Promise<void>;
}

export interface DiagnosticsNativeBridge {
  readPendingRecords(): Promise<string>;
  acknowledgeRecords(ids: string[]): Promise<boolean>;
  startMainThreadProbe(): void;
  stopMainThreadProbe(): void;
}

export interface FrameRateSnapshot {
  renderedFrames: number;
  expectedFrames: number;
  droppedFrames: number;
  frozenFrames: number;
  slowFrames: number;
  freezeTime: number;
  sessionDuration: number;
}

export interface SessionCounts {
  feedCount: number;
  runningCount: number;
}

export interface SessionDiagnosticsRuntimeOptions {
  storage: DiagnosticsStorage;
  native?: DiagnosticsNativeBridge | null;
  observe: DiagnosticsObserve;
  appVersion: string;
  buildNumber: string;
  now?: () => number;
  monotonicNow?: () => number;
  createId: () => string;
  getFrameRateMetrics?: () => Promise<FrameRateSnapshot>;
  getSessionCounts?: () => SessionCounts;
}

interface PersistedJournal {
  schemaVersion: 1;
  reportId: string;
  appVersion: string;
  buildNumber: string;
  startedAtMs: number;
  lastCheckpointAtMs: number;
  droppedEventCount: number;
  events: DiagnosticEvent[];
}

interface PersistedOutbox {
  schemaVersion: 1;
  droppedReportCount: number;
  nativeDroppedCountSeen: number;
  nativeRecordIds: string[];
  reports: PendingDiagnosticReport[];
}

interface NativeRecordEnvelope {
  processId: string;
  droppedCount: number;
  records: Array<Record<string, unknown> & { id?: string; processId?: string }>;
}

interface Bucket {
  count: number;
  bytes: number;
  maxDurationMs: number;
  opens: number;
  closes: number;
  errors: number;
}

interface FrameBaseline {
  sampledAtMs: number;
  metrics: FrameRateSnapshot;
}

const EMPTY_OUTBOX: PersistedOutbox = {
  schemaVersion: 1,
  droppedReportCount: 0,
  nativeDroppedCountSeen: 0,
  nativeRecordIds: [],
  reports: [],
};

export class SessionDiagnosticsRuntime {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly journal = new BoundedDiagnosticsJournal();
  private readonly earlyEvents: DiagnosticEvent[] = [];
  private earlyDroppedEventCount = 0;
  private readonly sseBuckets = new Map<DiagnosticSource, Bucket>();
  private readonly storeBuckets = new Map<DiagnosticSource, Bucket>();
  private readonly feedRenderBucket: Bucket = {
    count: 0,
    bytes: 0,
    maxDurationMs: 0,
    opens: 0,
    closes: 0,
    errors: 0,
  };
  private appState: DiagnosticsAppState = 'unknown';
  private initialized = false;
  private initialization: Promise<boolean> | null = null;
  private checkpointQueue: Promise<void> = Promise.resolve();
  private dispatchQueue: Promise<void> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedJsTickAtMonotonicMs = 0;
  private jsBucketStartedAtMs = 0;
  private jsBucketStartedAtMonotonicMs = 0;
  private jsProbeCount = 0;
  private maxJsDelayMs = 0;
  private lastPeriodicCheckpointAtMonotonicMs = 0;
  private frameBaseline: FrameBaseline | null = null;
  private frameSamplePending = false;
  private operationSequence = 0;
  private persistedJournal: PersistedJournal | null = null;
  private outbox: PersistedOutbox = { ...EMPTY_OUTBOX };

  constructor(private readonly options: SessionDiagnosticsRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? readMonotonicTime;
  }

  initialize(): Promise<boolean> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().then((initialized) => {
        if (!initialized && !this.initialized) this.initialization = null;
        return initialized;
      });
    }
    return this.initialization;
  }

  record(input: unknown): void {
    const event = normalizeDiagnosticEvent(input);
    if (!event) return;
    if (!this.initialized) {
      this.earlyEvents.push(event);
      while (this.earlyEvents.length > SESSION_DIAGNOSTICS_LIMITS.maxEntries) {
        this.earlyEvents.shift();
        this.earlyDroppedEventCount += 1;
      }
      return;
    }
    this.journal.append(event, this.now());
  }

  setAppState(nextState: DiagnosticsAppState): void {
    if (nextState === this.appState) return;
    const previousState = this.appState;
    this.appState = nextState;
    if (nextState === 'active' || nextState === 'inactive' || nextState === 'background') {
      this.record({
        timestampMs: this.now(),
        kind: 'lifecycle',
        source: 'app',
        phase: nextState === 'active' ? 'resumed' : 'begin',
        platform: 'js',
        state: nextState,
      });
    }

    if (!this.initialized) return;
    if (nextState === 'active') {
      this.startForegroundSampling();
      return;
    }
    if (
      previousState === 'active'
      || this.activeTimer !== null
      || (nextState === 'background' && previousState === 'inactive')
    ) {
      this.stopForegroundSampling();
      this.flushJsBucket(this.now());
      // One asynchronous lifecycle checkpoint is best effort. There is no
      // synchronous flush, background timer, or claim that this write completed.
      void this.checkpoint(true);
    }
  }

  recordRoute(source: DiagnosticSource): void {
    this.record({
      timestampMs: this.now(),
      kind: 'route',
      source,
      phase: 'end',
      platform: 'js',
    });
  }

  recordModal(
    source: ModalDiagnosticSource,
    variant: 'compact' | 'expanded' | 'popover',
    visible: boolean,
  ): void {
    this.record({
      timestampMs: this.now(),
      kind: 'modal',
      source,
      phase: visible ? 'begin' : 'end',
      value: variant === 'compact' ? 1 : variant === 'expanded' ? 2 : 3,
      platform: 'js',
    });
  }

  recordSseMessage(source: DiagnosticSource, bytes: number): void {
    if (this.appState !== 'active' || !isSseSource(source)) return;
    const bucket = this.getBucket(this.sseBuckets, source);
    bucket.count += 1;
    bucket.bytes += Math.max(0, Math.trunc(bytes));
  }

  recordSseConnection(
    source: DiagnosticSource,
    state: 'open' | 'close' | 'error',
  ): void {
    if (this.appState !== 'active' || !isSseSource(source)) return;
    const bucket = this.getBucket(this.sseBuckets, source);
    if (state === 'open') bucket.opens += 1;
    if (state === 'close') bucket.closes += 1;
    if (state === 'error') bucket.errors += 1;
  }

  recordStoreUpdate(source: DiagnosticSource): void {
    if (this.appState !== 'active' || !isStoreSource(source)) return;
    this.getBucket(this.storeBuckets, source).count += 1;
  }

  recordFeedRender(durationMs: number): void {
    if (this.appState !== 'active') return;
    this.feedRenderBucket.count += 1;
    this.feedRenderBucket.maxDurationMs = Math.max(
      this.feedRenderBucket.maxDurationMs,
      safeDuration(durationMs),
    );
  }

  beginOperation(source: DiagnosticSource, operationCode: number): DiagnosticOperation {
    const startedAtMs = this.now();
    const startedAtMonotonicMs = this.monotonicNow();
    const id = ++this.operationSequence;
    this.record({
      timestampMs: startedAtMs,
      kind: 'operation',
      source,
      phase: 'begin',
      operationId: id,
      value: operationCode,
      platform: 'js',
    });
    return { id, startedAtMs, startedAtMonotonicMs };
  }

  endOperation(
    source: DiagnosticSource,
    operationCode: number,
    operation: DiagnosticOperation,
    failed = false,
  ): void {
    this.record({
      timestampMs: this.now(),
      kind: 'operation',
      source,
      phase: 'end',
      operationId: operation.id,
      value: operationCode,
      durationMs: Math.max(0, this.monotonicNow() - operation.startedAtMonotonicMs),
      failed,
      platform: 'js',
    });
  }

  async checkpoint(allowInactive = false): Promise<boolean> {
    if (!this.initialized) {
      const initialized = await this.initialize();
      if (!initialized) return false;
    }
    if (!allowInactive && this.appState !== 'active') return false;

    const begin = this.beginOperation('async_storage', 1);
    const snapshotAtMs = this.now();
    this.flushAggregateBuckets(snapshotAtMs);
    const journalValue = this.createCurrentJournal(snapshotAtMs);
    const serialized = JSON.stringify(journalValue);
    if (utf8ByteLength(serialized) > MAX_JOURNAL_STORAGE_BYTES) {
      this.journal.append({
        timestampMs: snapshotAtMs,
        kind: 'drop_summary',
        source: 'async_storage',
        count: 1,
      }, snapshotAtMs);
      this.endOperation('async_storage', 1, begin, true);
      return false;
    }

    const write = this.checkpointQueue.then(async () => {
      try {
        await this.options.storage.setItem(SESSION_DIAGNOSTICS_JOURNAL_KEY, serialized);
        this.persistedJournal = journalValue;
        this.endOperation('async_storage', 1, begin, false);
        return true;
      } catch {
        this.endOperation('async_storage', 1, begin, true);
        return false;
      }
    });
    this.checkpointQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async recordInternalVerification(enabled: boolean): Promise<boolean> {
    if (!enabled || !this.initialized) return false;
    try {
      if (await this.options.storage.getItem(SESSION_DIAGNOSTICS_VERIFY_KEY)) return false;
      await this.options.storage.setItem(SESSION_DIAGNOSTICS_VERIFY_KEY, 'attempted');
      this.record({
        timestampMs: this.now(),
        kind: 'verification',
        source: 'app',
        phase: 'checkpoint',
        platform: 'js',
      });
      return await this.checkpoint(true);
    } catch {
      return false;
    }
  }

  dispatchPendingReports(): Promise<void> {
    if (this.dispatchQueue) return this.dispatchQueue;
    this.dispatchQueue = this.dispatchPendingReportsOnce().finally(() => {
      this.dispatchQueue = null;
    });
    return this.dispatchQueue;
  }

  getCurrentSnapshot(): DiagnosticEvent[] {
    return this.journal.snapshot(this.now()).events;
  }

  getPendingReports(): PendingDiagnosticReport[] {
    return this.outbox.reports.map((report) => ({ ...report, chunks: [...report.chunks] }));
  }

  private async initializeOnce(): Promise<boolean> {
    let journalRaw: string | null = null;
    let outboxRaw: string | null = null;
    try {
      [journalRaw, outboxRaw] = await Promise.all([
        this.options.storage.getItem(SESSION_DIAGNOSTICS_JOURNAL_KEY),
        this.options.storage.getItem(SESSION_DIAGNOSTICS_OUTBOX_KEY),
      ]);
    } catch {
      // Do not replace a prior durable snapshot with empty state after a read
      // failure. Diagnostics are optional, so defer recovery and native ACK.
      return false;
    }

    const previousJournal = parseJournal(journalRaw);
    const priorOutbox = parseOutbox(outboxRaw, this.now());
    this.outbox = {
      ...priorOutbox,
      reports: reopenReportsAfterRestart(priorOutbox.reports),
    };
    const retention = retainPendingReports(this.outbox.reports, this.now());
    this.outbox.reports = retention.reports;
    this.outbox.droppedReportCount += retention.droppedCount;

    const nativeReadOperation = this.beginOperation('native_lifecycle', 3);
    const nativeEnvelope = await this.readNativeRecords();
    this.endOperation('native_lifecycle', 3, nativeReadOperation);
    const previouslySeenNativeIds = new Set(this.outbox.nativeRecordIds);
    const olderNativeRecords = nativeEnvelope.records.filter(
      (record) => record.processId !== nativeEnvelope.processId,
    );
    const unreportedNativeRecords = olderNativeRecords.filter(
      (record) => typeof record.id === 'string' && !previouslySeenNativeIds.has(record.id),
    );
    const nativeEvents = unreportedNativeRecords
      .map((record) => normalizeDiagnosticEvent({ ...record, diagnosticId: record.id }))
      .filter((event): event is DiagnosticEvent => event !== null);
    const previousEvents = previousJournal
      ? previousJournal.events.map(normalizeDiagnosticEvent)
        .filter((event): event is DiagnosticEvent => event !== null)
      : [];
    previousEvents.push(...nativeEvents);

    const nativeDropDelta = Math.max(
      0,
      nativeEnvelope.droppedCount - this.outbox.nativeDroppedCountSeen,
    );
    this.outbox.nativeDroppedCountSeen = Math.max(
      this.outbox.nativeDroppedCountSeen,
      nativeEnvelope.droppedCount,
    );
    if (nativeDropDelta > 0) {
      previousEvents.push({
        timestampMs: this.now(),
        kind: 'drop_summary',
        source: 'native_storage',
        count: nativeDropDelta,
      });
    }
    if ((previousJournal?.droppedEventCount ?? 0) > 0) {
      previousEvents.push({
        timestampMs: previousJournal?.lastCheckpointAtMs ?? this.now(),
        kind: 'drop_summary',
        source: 'app',
        count: previousJournal?.droppedEventCount,
      });
    }

    if (previousEvents.length > 0) {
      const previousReportId = previousJournal?.reportId ?? this.options.createId();
      const bounds = reportBounds(previousEvents);
      const created = createReportChunks({
        reportId: previousReportId,
        appVersion: previousJournal?.appVersion ?? this.options.appVersion,
        buildNumber: previousJournal?.buildNumber ?? this.options.buildNumber,
        windowStartMs: bounds.start,
        windowEndMs: bounds.end,
        events: previousEvents,
        droppedCount: this.outbox.droppedReportCount + (previousJournal?.droppedEventCount ?? 0),
        incompleteOperationCount: countIncompleteOperations(previousEvents),
      });
      if (created.chunks.length > 0) {
        const report: PendingDiagnosticReport = {
          reportId: previousReportId,
          createdAtMs: this.now(),
          expiresAtMs: this.now() + SESSION_DIAGNOSTICS_LIMITS.reportTtlMs,
          attemptCount: 0,
          status: 'pending',
          chunks: created.chunks,
          appVersion: previousJournal?.appVersion ?? this.options.appVersion,
          buildNumber: previousJournal?.buildNumber ?? this.options.buildNumber,
          windowStartMs: bounds.start,
          windowEndMs: bounds.end,
        };
        this.outbox.reports.push(report);
      }
      this.outbox.droppedReportCount += created.droppedEventCount;
    }

    const retained = retainPendingReports(this.outbox.reports, this.now());
    this.outbox.reports = retained.reports;
    this.outbox.droppedReportCount += retained.droppedCount;
    this.outbox.nativeRecordIds = [
      ...this.outbox.nativeRecordIds,
      ...olderNativeRecords.flatMap((record) => typeof record.id === 'string' ? [record.id] : []),
    ].slice(-MAX_REMEMBERED_NATIVE_IDS);

    const newRunAtMs = this.now();
    this.persistedJournal = {
      schemaVersion: 1,
      reportId: this.options.createId(),
      appVersion: safeVersion(this.options.appVersion),
      buildNumber: safeVersion(this.options.buildNumber),
      startedAtMs: newRunAtMs,
      lastCheckpointAtMs: newRunAtMs,
      droppedEventCount: 0,
      events: [],
    };
    this.journal.replace(this.earlyEvents, newRunAtMs, this.earlyDroppedEventCount);
    this.earlyEvents.length = 0;
    this.earlyDroppedEventCount = 0;
    if (this.outbox.droppedReportCount > 0) {
      this.journal.append({
        timestampMs: newRunAtMs,
        kind: 'drop_summary',
        source: 'async_storage',
        count: this.outbox.droppedReportCount,
      }, newRunAtMs);
    }

    const outboxSaved = await this.persistOutbox();
    const journalSaved = await this.persistCurrentJournal();
    this.initialized = true;
    if (outboxSaved && journalSaved && olderNativeRecords.length > 0 && this.options.native) {
      const ids = olderNativeRecords.flatMap((record) => typeof record.id === 'string' ? [record.id] : []);
      if (ids.length > 0) {
        const acknowledgeOperation = this.beginOperation('native_lifecycle', 4);
        try {
          const acknowledged = await this.options.native.acknowledgeRecords(ids);
          this.endOperation('native_lifecycle', 4, acknowledgeOperation, !acknowledged);
        } catch {
          this.endOperation('native_lifecycle', 4, acknowledgeOperation, true);
          // The stable diagnosticId in the report deduplicates a native record
          // if the file acknowledgement did not complete.
        }
      }
    }

    if (this.appState === 'active') this.startForegroundSampling();
    void this.dispatchPendingReports();
    return outboxSaved && journalSaved;
  }

  private async dispatchPendingReportsOnce(): Promise<void> {
    if (!this.initialized) {
      if (!await this.initialize()) return;
    }
    const nowMs = this.now();
    const originalReports = this.outbox.reports.map((report) => ({ ...report }));
    const preparedById = new Map<string, PendingDiagnosticReport>();
    this.outbox.reports = this.outbox.reports.map((report) => {
      const prepared = prepareReportDispatch(report, nowMs);
      if (!prepared) return report;
      preparedById.set(report.reportId, prepared.report);
      return prepared.report;
    });
    if (preparedById.size === 0) return;
    if (!await this.persistOutbox()) {
      this.outbox.reports = originalReports;
      return;
    }

    const enqueueOperation = this.beginOperation('observe', 1);
    await this.checkpoint(true);
    const failedReportIds = new Set<string>();
    let queuedChunkCount = 0;
    for (const report of this.outbox.reports) {
      if (!preparedById.has(report.reportId)) continue;
      let reportFailed = false;
      for (const body of report.chunks) {
        if (utf8ByteLength(body) > SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes) {
          reportFailed = true;
          break;
        }
        if (!this.options.observe.logEvent(SESSION_DIAGNOSTICS_EVENT_NAME, body)) {
          reportFailed = true;
          break;
        }
        queuedChunkCount += 1;
      }
      if (reportFailed) failedReportIds.add(report.reportId);
    }
    this.endOperation('observe', 1, enqueueOperation, failedReportIds.size > 0);

    const dispatchOperation = this.beginOperation('observe', 2);
    await this.checkpoint(true);
    let dispatchFailed = false;
    if (queuedChunkCount > 0) {
      try {
        await this.options.observe.dispatchEvents();
      } catch {
        dispatchFailed = true;
      }
    } else {
      dispatchFailed = true;
    }
    this.endOperation('observe', 2, dispatchOperation, dispatchFailed);

    this.outbox.reports = this.outbox.reports.map((report) => {
      if (!preparedById.has(report.reportId)) return report;
      const settled = markSdkCallFinishedUnconfirmed(report, this.now());
      settled.lastDispatchFailed = dispatchFailed || failedReportIds.has(report.reportId);
      return settled;
    });
    await this.persistOutbox();
    await this.checkpoint(true);
  }

  private async readNativeRecords(): Promise<NativeRecordEnvelope> {
    if (!this.options.native) return { processId: '', droppedCount: 0, records: [] };
    try {
      const json = await this.options.native.readPendingRecords();
      if (utf8ByteLength(json) > 20 * 1024) {
        return { processId: '', droppedCount: 0, records: [] };
      }
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed) || !Array.isArray(parsed.records) || typeof parsed.processId !== 'string' || !isUuid(parsed.processId)) {
        return { processId: '', droppedCount: 0, records: [] };
      }
      return {
        processId: typeof parsed.processId === 'string' ? parsed.processId : '',
        droppedCount: nonNegativeInteger(parsed.droppedCount),
        records: parsed.records.slice(-MAX_NATIVE_RECORDS_IN_ENVELOPE)
          .filter(isRecord) as NativeRecordEnvelope['records'],
      };
    } catch {
      return { processId: '', droppedCount: 0, records: [] };
    }
  }

  private async persistOutbox(): Promise<boolean> {
    const operation = this.initialized ? this.beginOperation('async_storage', 2) : null;
    const normalized = retainPendingReports(this.outbox.reports, this.now());
    this.outbox.reports = normalized.reports;
    this.outbox.droppedReportCount += normalized.droppedCount;
    let serialized = JSON.stringify(this.outbox);
    while (
      utf8ByteLength(serialized) > MAX_OUTBOX_STORAGE_BYTES
      && this.outbox.reports.length > 0
    ) {
      this.outbox.reports.shift();
      this.outbox.droppedReportCount += 1;
      serialized = JSON.stringify(this.outbox);
    }
    if (utf8ByteLength(serialized) > MAX_OUTBOX_STORAGE_BYTES) {
      if (operation) this.endOperation('async_storage', 2, operation, true);
      return false;
    }
    try {
      await this.options.storage.setItem(SESSION_DIAGNOSTICS_OUTBOX_KEY, serialized);
      if (operation) this.endOperation('async_storage', 2, operation);
      return true;
    } catch {
      if (operation) this.endOperation('async_storage', 2, operation, true);
      return false;
    }
  }

  private async persistCurrentJournal(): Promise<boolean> {
    const journalValue = this.createCurrentJournal(this.now());
    const serialized = JSON.stringify(journalValue);
    if (utf8ByteLength(serialized) > MAX_JOURNAL_STORAGE_BYTES) return false;
    try {
      await this.options.storage.setItem(SESSION_DIAGNOSTICS_JOURNAL_KEY, serialized);
      this.persistedJournal = journalValue;
      return true;
    } catch {
      return false;
    }
  }

  private createCurrentJournal(nowMs: number): PersistedJournal {
    const snapshot = this.journal.snapshot(nowMs);
    const metadata = this.persistedJournal;
    return {
      schemaVersion: 1,
      reportId: metadata?.reportId ?? this.options.createId(),
      appVersion: metadata?.appVersion ?? safeVersion(this.options.appVersion),
      buildNumber: metadata?.buildNumber ?? safeVersion(this.options.buildNumber),
      startedAtMs: metadata?.startedAtMs ?? nowMs,
      lastCheckpointAtMs: nowMs,
      droppedEventCount: snapshot.droppedCount,
      events: snapshot.events,
    };
  }

  private startForegroundSampling(): void {
    this.options.native?.startMainThreadProbe();
    this.frameBaseline = null;
    const nowMs = this.now();
    const nowMonotonicMs = this.monotonicNow();
    this.expectedJsTickAtMonotonicMs = nowMonotonicMs + JS_PROBE_INTERVAL_MS;
    this.jsBucketStartedAtMs = nowMs;
    this.jsBucketStartedAtMonotonicMs = nowMonotonicMs;
    this.jsProbeCount = 0;
    this.maxJsDelayMs = 0;
    this.lastPeriodicCheckpointAtMonotonicMs = nowMonotonicMs;
    this.scheduleJsProbe();
    void this.sampleFrameMetrics(nowMs);
  }

  private stopForegroundSampling(): void {
    if (this.activeTimer !== null) clearTimeout(this.activeTimer);
    this.activeTimer = null;
    this.options.native?.stopMainThreadProbe();
    this.frameBaseline = null;
  }

  private scheduleJsProbe(): void {
    if (this.appState !== 'active' || this.activeTimer !== null) return;
    this.activeTimer = setTimeout(() => {
      this.activeTimer = null;
      this.onJsProbeTick();
    }, JS_PROBE_INTERVAL_MS);
  }

  private onJsProbeTick(): void {
    if (this.appState !== 'active') return;
    const nowMs = this.now();
    const nowMonotonicMs = this.monotonicNow();
    const delayMs = Math.max(0, nowMonotonicMs - this.expectedJsTickAtMonotonicMs);
    this.expectedJsTickAtMonotonicMs = nowMonotonicMs + JS_PROBE_INTERVAL_MS;
    if (delayMs >= JS_AMBIGUOUS_SUSPENSION_GAP_MS) {
      // A long timer gap after resume is ambiguous: JS may have been suspended
      // with the app in background. Keep shorter foreground stalls measurable,
      // but never label a long wall-clock gap as a JS hang by itself.
      this.flushAggregateBuckets(nowMs);
      this.jsBucketStartedAtMs = nowMs;
      this.jsBucketStartedAtMonotonicMs = nowMonotonicMs;
      this.jsProbeCount = 0;
      this.maxJsDelayMs = 0;
      this.lastPeriodicCheckpointAtMonotonicMs = nowMonotonicMs;
      this.frameBaseline = null;
      void this.sampleFrameMetrics(nowMs);
      this.scheduleJsProbe();
      return;
    }
    this.jsProbeCount += 1;
    this.maxJsDelayMs = Math.max(this.maxJsDelayMs, delayMs);

    if (nowMonotonicMs - this.jsBucketStartedAtMonotonicMs >= SESSION_DIAGNOSTICS_LIMITS.checkpointMs) {
      this.flushJsBucket(nowMs);
    }
    if (nowMonotonicMs - this.lastPeriodicCheckpointAtMonotonicMs >= SESSION_DIAGNOSTICS_LIMITS.checkpointMs) {
      this.lastPeriodicCheckpointAtMonotonicMs = nowMonotonicMs;
      void this.sampleFrameMetrics(nowMs);
      void this.checkpoint(false);
    }
    this.scheduleJsProbe();
  }

  private flushJsBucket(nowMs: number): void {
    if (this.jsProbeCount > 0 && this.maxJsDelayMs >= JS_EVENT_LOOP_DELAY_THRESHOLD_MS) {
      this.journal.append({
        timestampMs: nowMs,
        kind: 'js_loop_bucket',
        source: 'app',
        phase: 'bucket',
        count: this.jsProbeCount,
        maxResponseMs: this.maxJsDelayMs,
        windowStartMs: this.jsBucketStartedAtMs,
        windowEndMs: nowMs,
        platform: 'js',
      }, nowMs);
    }
    this.jsBucketStartedAtMs = nowMs;
    this.jsBucketStartedAtMonotonicMs = this.monotonicNow();
    this.jsProbeCount = 0;
    this.maxJsDelayMs = 0;
  }

  private flushAggregateBuckets(nowMs: number): void {
    this.flushJsBucket(nowMs);
    for (const [source, bucket] of this.sseBuckets) {
      if (
        bucket.count === 0
        && bucket.opens === 0
        && bucket.closes === 0
        && bucket.errors === 0
      ) continue;
      this.journal.append({
        timestampMs: nowMs,
        kind: 'sse_bucket',
        source,
        phase: 'bucket',
        count: bucket.count,
        bytes: bucket.bytes,
        sseOpenCount: bucket.opens,
        sseCloseCount: bucket.closes,
        sseErrorCount: bucket.errors,
        platform: 'js',
      }, nowMs);
    }
    this.sseBuckets.clear();

    for (const [source, bucket] of this.storeBuckets) {
      if (bucket.count === 0) continue;
      this.journal.append({
        timestampMs: nowMs,
        kind: 'store_bucket',
        source,
        phase: 'bucket',
        count: bucket.count,
        platform: 'js',
      }, nowMs);
    }
    this.storeBuckets.clear();

    if (this.feedRenderBucket.count > 0) {
      this.journal.append({
        timestampMs: nowMs,
        kind: 'feed_render',
        source: 'feed',
        phase: 'bucket',
        count: this.feedRenderBucket.count,
        maxResponseMs: this.feedRenderBucket.maxDurationMs,
        platform: 'js',
      }, nowMs);
      this.feedRenderBucket.count = 0;
      this.feedRenderBucket.maxDurationMs = 0;
    }

    try {
      const counts = this.options.getSessionCounts?.();
      if (counts) {
        this.journal.append({
          timestampMs: nowMs,
          kind: 'active_sessions',
          source: 'feed',
          phase: 'bucket',
          count: nonNegativeInteger(counts.feedCount),
          value: nonNegativeInteger(counts.runningCount),
          platform: 'js',
        }, nowMs);
      }
    } catch {
      // Store inspection is optional diagnostics and cannot change app behavior.
    }
  }

  private async sampleFrameMetrics(sampledAtMs: number): Promise<void> {
    const getMetrics = this.options.getFrameRateMetrics;
    if (!getMetrics || this.frameSamplePending || this.appState !== 'active') return;
    this.frameSamplePending = true;
    try {
      const metrics = await getMetrics();
      if (this.appState !== 'active') return;
      const previous = this.frameBaseline;
      this.frameBaseline = { sampledAtMs, metrics };
      if (!previous) return;
      const delta = (key: keyof FrameRateSnapshot) => Math.max(0, metrics[key] - previous.metrics[key]);
      this.journal.append({
        timestampMs: sampledAtMs,
        kind: 'frame_bucket',
        source: 'native_displaylink',
        phase: 'bucket',
        windowStartMs: previous.sampledAtMs,
        windowEndMs: sampledAtMs,
        renderedFrames: delta('renderedFrames'),
        expectedFrames: delta('expectedFrames'),
        droppedFrames: delta('droppedFrames'),
        slowFrames: delta('slowFrames'),
        frozenFrames: delta('frozenFrames'),
        freezeTimeMs: delta('freezeTime') * 1000,
        durationMs: delta('sessionDuration') * 1000,
        platform: 'native',
      }, sampledAtMs);
    } catch {
      // Frame metrics are optional and their failures do not touch app recovery.
    } finally {
      this.frameSamplePending = false;
    }
  }

  private getBucket(map: Map<DiagnosticSource, Bucket>, source: DiagnosticSource): Bucket {
    let bucket = map.get(source);
    if (!bucket) {
      bucket = { count: 0, bytes: 0, maxDurationMs: 0, opens: 0, closes: 0, errors: 0 };
      map.set(source, bucket);
    }
    return bucket;
  }
}

function parseJournal(value: string | null): PersistedJournal | null {
  if (!value || utf8ByteLength(value) > MAX_JOURNAL_STORAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.events)) return null;
    if (typeof parsed.reportId !== 'string' || typeof parsed.appVersion !== 'string' || typeof parsed.buildNumber !== 'string') {
      return null;
    }
    const events = parsed.events
      .slice(-SESSION_DIAGNOSTICS_LIMITS.maxEntries)
      .map(normalizeDiagnosticEvent)
      .filter((event): event is DiagnosticEvent => event !== null);
    return {
      schemaVersion: 1,
      reportId: parsed.reportId,
      appVersion: safeVersion(parsed.appVersion),
      buildNumber: safeVersion(parsed.buildNumber),
      startedAtMs: nonNegativeInteger(parsed.startedAtMs),
      lastCheckpointAtMs: nonNegativeInteger(parsed.lastCheckpointAtMs),
      droppedEventCount: nonNegativeInteger(parsed.droppedEventCount),
      events,
    };
  } catch {
    return null;
  }
}

function parseOutbox(value: string | null, nowMs: number): PersistedOutbox {
  if (!value || utf8ByteLength(value) > MAX_OUTBOX_STORAGE_BYTES) return { ...EMPTY_OUTBOX };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.reports)) {
      return { ...EMPTY_OUTBOX };
    }
    const reports = parsed.reports.flatMap((candidate): PendingDiagnosticReport[] => {
      if (!isRecord(candidate) || !Array.isArray(candidate.chunks)) return [];
      if (typeof candidate.reportId !== 'string' || typeof candidate.appVersion !== 'string' || typeof candidate.buildNumber !== 'string') return [];
      const chunks = candidate.chunks.filter((chunk): chunk is string =>
        typeof chunk === 'string'
        && utf8ByteLength(chunk) <= SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes,
      );
      if (chunks.length !== candidate.chunks.length) return [];
      const report: PendingDiagnosticReport = {
        reportId: candidate.reportId,
        createdAtMs: nonNegativeInteger(candidate.createdAtMs),
        expiresAtMs: nonNegativeInteger(candidate.expiresAtMs),
        attemptCount: Math.min(SESSION_DIAGNOSTICS_LIMITS.maxDispatchAttempts, nonNegativeInteger(candidate.attemptCount)),
        status: candidate.status === 'dispatch_requested' || candidate.status === 'sdk_call_finished_unconfirmed'
          ? candidate.status
          : 'pending',
        chunks,
        appVersion: safeVersion(candidate.appVersion),
        buildNumber: safeVersion(candidate.buildNumber),
        windowStartMs: nonNegativeInteger(candidate.windowStartMs),
        windowEndMs: nonNegativeInteger(candidate.windowEndMs),
      };
      if (typeof candidate.lastDispatchRequestedAtMs === 'number') report.lastDispatchRequestedAtMs = nonNegativeInteger(candidate.lastDispatchRequestedAtMs);
      if (typeof candidate.lastSdkCallFinishedAtMs === 'number') report.lastSdkCallFinishedAtMs = nonNegativeInteger(candidate.lastSdkCallFinishedAtMs);
      if (typeof candidate.lastDispatchFailed === 'boolean') report.lastDispatchFailed = candidate.lastDispatchFailed;
      return [report];
    });
    const retained = retainPendingReports(reports, nowMs);
    return {
      schemaVersion: 1,
      droppedReportCount: nonNegativeInteger(parsed.droppedReportCount) + retained.droppedCount,
      nativeDroppedCountSeen: nonNegativeInteger(parsed.nativeDroppedCountSeen),
      nativeRecordIds: Array.isArray(parsed.nativeRecordIds)
        ? parsed.nativeRecordIds.filter((id): id is string => typeof id === 'string' && isUuid(id)).slice(-MAX_REMEMBERED_NATIVE_IDS)
        : [],
      reports: retained.reports,
    };
  } catch {
    return { ...EMPTY_OUTBOX };
  }
}

function reportBounds(events: readonly DiagnosticEvent[]): { start: number; end: number } {
  const starts = events.map((event) => event.windowStartMs ?? event.timestampMs);
  const ends = events.map((event) => event.windowEndMs ?? event.timestampMs);
  return {
    start: Math.min(...starts),
    end: Math.max(...ends),
  };
}

function countIncompleteOperations(events: readonly DiagnosticEvent[]): number {
  const began = new Set<string>();
  const ended = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'operation' || event.operationId === undefined) continue;
    const key = `${event.source}:${event.operationId}`;
    if (event.phase === 'begin') began.add(key);
    if (event.phase === 'end') ended.add(key);
  }
  return [...began].filter((key) => !ended.has(key)).length;
}

function safeVersion(value: string): string {
  return /^[A-Za-z0-9.+_-]{1,32}$/.test(value) ? value : 'unknown';
}

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readMonotonicTime(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSseSource(value: DiagnosticSource): boolean {
  return value === 'node_stream' || value === 'feed_stream' || value === 'chat_stream';
}

function isStoreSource(value: DiagnosticSource): boolean {
  return value === 'session'
    || value === 'chat'
    || value === 'auth'
    || value === 'catalog'
    || value === 'settings'
    || value === 'ui'
    || value === 'planner_store'
    || value === 'nodes'
    || value === 'search'
    || value === 'other';
}
