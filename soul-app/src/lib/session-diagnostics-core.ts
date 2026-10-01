export const SESSION_DIAGNOSTICS_LIMITS = Object.freeze({
  windowMs: 60_000,
  maxEntries: 128,
  maxBytes: 32 * 1024,
  checkpointMs: 5_000,
  reportTtlMs: 72 * 60 * 60 * 1000,
  maxPendingReports: 3,
  maxPendingBytes: 3 * 32 * 1024,
  maxDispatchAttempts: 3,
  maxChunkBodyBytes: 3_000,
  maxChunks: 12,
  maxStackFrames: 16,
  maxFrameBinaryNameLength: 48,
});

const MAX_CRASH_STACK_FRAMES = 20;

export const DIAGNOSTIC_KINDS = [
  'route',
  'modal',
  'lifecycle',
  'operation',
  'sse_bucket',
  'store_bucket',
  'feed_render',
  'js_loop_bucket',
  'frame_bucket',
  'native_main_probe',
  'native_hang',
  'native_crash',
  'active_sessions',
  'drop_summary',
  'verification',
] as const;

export const DIAGNOSTIC_SOURCES = [
  'app',
  'feed',
  'chat',
  'planner',
  'search',
  'settings',
  'node_stream',
  'feed_stream',
  'chat_stream',
  'secure_store',
  'async_storage',
  'usage_storage',
  'widget_storage',
  'push_storage',
  'session',
  'auth',
  'catalog',
  'ui',
  'planner_store',
  'nodes',
  'session_ui',
  'usage_widget',
  'native_lifecycle',
  'native_storage',
  'native_displaylink',
  'native_probe',
  'metrickit',
  'observe',
  'modal_settings',
  'modal_morning_review',
  'modal_new_task',
  'modal_card_detail',
  'modal_card_assignment',
  'modal_session_succession',
  'modal_claude_runtime_tasks',
  'modal_search_filter',
  'modal_session_succession_diagnostic',
  'other',
] as const;

export const DIAGNOSTIC_PHASES = [
  'begin',
  'end',
  'timeout',
  'bucket',
  'checkpoint',
  'resumed',
] as const;

export const DIAGNOSTIC_STATES = [
  'active',
  'inactive',
  'background',
  'will_resign_active',
  'did_enter_background',
  'will_enter_foreground',
  'did_become_active',
  'will_terminate',
] as const;

export const DIAGNOSTIC_PLATFORMS = ['js', 'native'] as const;
export const DIAGNOSTIC_TYPES = ['hang', 'crash', 'other'] as const;
export const STACK_BINARY_CLASSES = [
  'soul_app',
  'react_native',
  'hermes',
  'uikit',
  'quartz_core',
  'core_animation',
  'core_graphics',
  'core_foundation',
  'swift_ui',
  'foundation',
  'libdispatch',
  'system_runtime',
  'other',
] as const;

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];
export type ModalDiagnosticSource = Extract<DiagnosticSource, `modal_${string}`>;
export type DiagnosticPhase = (typeof DIAGNOSTIC_PHASES)[number];
export type DiagnosticState = (typeof DIAGNOSTIC_STATES)[number];
export type DiagnosticPlatform = (typeof DIAGNOSTIC_PLATFORMS)[number];
export type DiagnosticType = (typeof DIAGNOSTIC_TYPES)[number];
export type StackBinaryClass = (typeof STACK_BINARY_CLASSES)[number];

export interface DiagnosticStackFrame {
  binary: StackBinaryClass;
  binaryUuid?: string;
  offset?: number;
  sampleCount?: number;
}

export interface DiagnosticEvent {
  diagnosticId?: string;
  appVersion?: string;
  buildNumber?: string;
  osVersion?: string;
  timestampMs: number;
  kind: DiagnosticKind;
  source: DiagnosticSource;
  phase?: DiagnosticPhase;
  state?: DiagnosticState;
  platform?: DiagnosticPlatform;
  diagnosticType?: DiagnosticType;
  terminationReason?: string;
  exceptionType?: number;
  signal?: number;
  value?: number;
  value2?: number;
  count?: number;
  bytes?: number;
  durationMs?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  operationId?: number;
  renderedFrames?: number;
  expectedFrames?: number;
  droppedFrames?: number;
  slowFrames?: number;
  frozenFrames?: number;
  sseOpenCount?: number;
  sseCloseCount?: number;
  sseErrorCount?: number;
  freezeTimeMs?: number;
  maxResponseMs?: number;
  failed?: boolean;
  stackTruncated?: boolean;
  stackFrames?: DiagnosticStackFrame[];
}

export interface DiagnosticSnapshot {
  events: DiagnosticEvent[];
  byteLength: number;
  droppedCount: number;
}

export type ReportDispatchStatus =
  | 'pending'
  | 'dispatch_requested'
  | 'sdk_call_finished_unconfirmed';

export interface PendingDiagnosticReport {
  reportId: string;
  createdAtMs: number;
  expiresAtMs: number;
  attemptCount: number;
  status: ReportDispatchStatus;
  chunks: string[];
  appVersion: string;
  buildNumber: string;
  windowStartMs: number;
  windowEndMs: number;
  lastDispatchRequestedAtMs?: number;
  lastSdkCallFinishedAtMs?: number;
  lastDispatchFailed?: boolean;
}

export interface CreateReportChunksInput {
  reportId: string;
  appVersion: string;
  buildNumber: string;
  windowStartMs: number;
  windowEndMs: number;
  events: readonly unknown[];
  droppedCount?: number;
  incompleteOperationCount?: number;
}

export interface CreateReportChunksResult {
  chunks: string[];
  totalBytes: number;
  droppedEventCount: number;
}

const EVENT_KEYS = new Set<string>([
  'timestampMs',
  'diagnosticId',
  'appVersion',
  'buildNumber',
  'osVersion',
  'kind',
  'source',
  'phase',
  'state',
  'platform',
  'diagnosticType',
  'terminationReason',
  'exceptionType',
  'signal',
  'value',
  'value2',
  'count',
  'bytes',
  'durationMs',
  'windowStartMs',
  'windowEndMs',
  'operationId',
  'renderedFrames',
  'expectedFrames',
  'droppedFrames',
  'slowFrames',
  'frozenFrames',
  'sseOpenCount',
  'sseCloseCount',
  'sseErrorCount',
  'freezeTimeMs',
  'maxResponseMs',
  'failed',
  'stackTruncated',
  'stackFrames',
]);

const NUMERIC_KEYS = [
  'timestampMs',
  'windowStartMs',
  'windowEndMs',
  'value',
  'value2',
  'count',
  'bytes',
  'durationMs',
  'renderedFrames',
  'expectedFrames',
  'droppedFrames',
  'slowFrames',
  'frozenFrames',
  'sseOpenCount',
  'sseCloseCount',
  'sseErrorCount',
  'freezeTimeMs',
  'maxResponseMs',
  'operationId',
  'exceptionType',
  'signal',
] as const;

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_ID_PATTERN = REPORT_ID_PATTERN;
const BINARY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9.+_-]{1,32}$/;
const OS_VERSION_PATTERN = /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}(?:\([A-Za-z0-9.]{1,16}\))?$/;
const ENUM_SETS = {
  kind: new Set<string>(DIAGNOSTIC_KINDS),
  source: new Set<string>(DIAGNOSTIC_SOURCES),
  phase: new Set<string>(DIAGNOSTIC_PHASES),
  state: new Set<string>(DIAGNOSTIC_STATES),
  platform: new Set<string>(DIAGNOSTIC_PLATFORMS),
  diagnosticType: new Set<string>(DIAGNOSTIC_TYPES),
  binary: new Set<string>(STACK_BINARY_CLASSES),
};

export function utf8ByteLength(value: string): number {
  // Hermes and Jest both provide encodeURIComponent. Counting percent-encoded
  // bytes avoids relying on TextEncoder, which is not present in every RN host.
  try {
    return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, 'x').length;
  } catch {
    // A lone surrogate becomes the three-byte UTF-8 replacement character.
    return value.length * 3;
  }
}

export function normalizeDiagnosticEvent(input: unknown): DiagnosticEvent | null {
  if (!isRecord(input)) return null;

  const timestampMs = finiteNumber(input.timestampMs);
  if (timestampMs === undefined) return null;
  const kind = enumValue(input.kind, ENUM_SETS.kind) as DiagnosticKind | undefined;
  if (!kind) return null;

  const event: Record<string, unknown> = {
    timestampMs: Math.trunc(timestampMs),
    kind,
    source: enumValue(input.source, ENUM_SETS.source) ?? 'other',
  };

  if (typeof input.diagnosticId === 'string' && DIAGNOSTIC_ID_PATTERN.test(input.diagnosticId)) {
    event.diagnosticId = input.diagnosticId;
  }
  if (typeof input.appVersion === 'string' && VERSION_PATTERN.test(input.appVersion)) {
    event.appVersion = input.appVersion;
  }
  if (typeof input.buildNumber === 'string' && VERSION_PATTERN.test(input.buildNumber)) {
    event.buildNumber = input.buildNumber;
  }
  if (typeof input.osVersion === 'string' && OS_VERSION_PATTERN.test(input.osVersion)) {
    event.osVersion = input.osVersion;
  }

  for (const key of ['phase', 'state', 'platform', 'diagnosticType'] as const) {
    const accepted = enumValue(input[key], ENUM_SETS[key]);
    if (accepted !== undefined) event[key] = accepted;
  }
  if (typeof input.terminationReason === 'string') {
    const firstLine = input.terminationReason.split(/[\r\n]/, 1)[0];
    if (
      firstLine.length <= 256
      && /^[A-Za-z0-9 _.,:;()/+\-<>|=@]+$/.test(firstLine)
    ) {
      event.terminationReason = firstLine;
    }
  }
  for (const key of NUMERIC_KEYS) {
    if (key === 'timestampMs') continue;
    const value = finiteNumber(input[key]);
    if (value !== undefined) {
      event[key] = key === 'value' || key === 'value2' || key === 'durationMs' || key === 'maxResponseMs' || key === 'freezeTimeMs'
        ? value
        : Math.trunc(value);
    }
  }
  if (typeof input.failed === 'boolean') event.failed = input.failed;
  if (typeof input.stackTruncated === 'boolean') event.stackTruncated = input.stackTruncated;
  if (Array.isArray(input.stackFrames)) {
    const maxStackFrames = kind === 'native_crash' && input.diagnosticType === 'crash'
      ? MAX_CRASH_STACK_FRAMES
      : SESSION_DIAGNOSTICS_LIMITS.maxStackFrames;
    if (input.stackFrames.length > maxStackFrames) {
      event.stackTruncated = true;
    }
    const stackFrames = input.stackFrames
      .slice(0, maxStackFrames)
      .flatMap((frame): DiagnosticStackFrame[] => {
        if (!isRecord(frame)) return [];
        const binary = enumValue(frame.binary, ENUM_SETS.binary) as StackBinaryClass | undefined;
        if (!binary) return [];
        const normalized: DiagnosticStackFrame = { binary };
        if (
          typeof frame.binaryUuid === 'string'
          && BINARY_UUID_PATTERN.test(frame.binaryUuid)
        ) {
          normalized.binaryUuid = frame.binaryUuid.toLowerCase();
        }
        const offset = finiteNumber(frame.offset);
        const sampleCount = finiteNumber(frame.sampleCount);
        if (offset !== undefined && offset >= 0 && offset <= Number.MAX_SAFE_INTEGER) {
          normalized.offset = Math.trunc(offset);
        }
        if (sampleCount !== undefined) normalized.sampleCount = Math.trunc(Math.max(0, sampleCount));
        return [normalized];
      });
    if (stackFrames.length > 0) event.stackFrames = stackFrames;
  }

  // Unknown keys are intentionally never copied. This is the boundary that
  // prevents titles, IDs, URLs, tokens, and raw native payloads from escaping.
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) delete event[key];
  }
  return event as unknown as DiagnosticEvent;
}

export class BoundedDiagnosticsJournal {
  private events: DiagnosticEvent[] = [];
  private droppedCount = 0;

  append(input: unknown, nowMs: number): DiagnosticEvent | null {
    this.prune(nowMs);
    const event = normalizeDiagnosticEvent(input);
    if (!event) return null;
    this.events.push(event);
    this.enforceBounds();
    return event;
  }

  replace(events: readonly unknown[], nowMs: number, priorDroppedCount = 0): void {
    this.events = [];
    this.droppedCount = Math.max(0, Math.trunc(priorDroppedCount));
    for (const event of events) this.append(event, nowMs);
    this.prune(nowMs);
  }

  snapshot(nowMs: number): DiagnosticSnapshot {
    this.prune(nowMs);
    return {
      events: this.events.map((event) => ({ ...event })),
      byteLength: utf8ByteLength(JSON.stringify(this.events)),
      droppedCount: this.droppedCount,
    };
  }

  private prune(nowMs: number): void {
    const cutoffMs = nowMs - SESSION_DIAGNOSTICS_LIMITS.windowMs;
    this.events = this.events.filter((event) => event.timestampMs >= cutoffMs);
    this.enforceBounds();
  }

  private enforceBounds(): void {
    while (
      this.events.length > SESSION_DIAGNOSTICS_LIMITS.maxEntries
      || utf8ByteLength(JSON.stringify(this.events)) > SESSION_DIAGNOSTICS_LIMITS.maxBytes
    ) {
      this.events.shift();
      this.droppedCount += 1;
    }
  }
}

export function createReportChunks(input: CreateReportChunksInput): CreateReportChunksResult {
  if (!REPORT_ID_PATTERN.test(input.reportId)) {
    return { chunks: [], totalBytes: 0, droppedEventCount: input.events.length };
  }
  const reportId = input.reportId;
  const appVersion = safeVersion(input.appVersion);
  const buildNumber = safeVersion(input.buildNumber);
  const start = safeTimestamp(input.windowStartMs);
  const end = Math.max(start, safeTimestamp(input.windowEndMs));
  let events = input.events
    .map(normalizeDiagnosticEvent)
    .filter((event): event is DiagnosticEvent => event !== null);
  let droppedEventCount = input.events.length - events.length;

  while (events.length > 0) {
    const droppedCount = Math.max(0, Math.trunc(input.droppedCount ?? 0)) + droppedEventCount;
    const incompleteOperationCount = Math.max(0, Math.trunc(input.incompleteOperationCount ?? 0));
    const groupedResult = groupEvents(events, {
      reportId,
      appVersion,
      buildNumber,
      windowStartMs: start,
      windowEndMs: end,
      droppedCount,
      incompleteOperationCount,
    });
    if (groupedResult.droppedEventCount > 0) {
      events = groupedResult.groups.flat();
      droppedEventCount += groupedResult.droppedEventCount;
      continue;
    }
    const grouped = groupedResult.groups;
    const chunks = grouped.map((group, index) => serializeChunk({
      reportId,
      appVersion,
      buildNumber,
      windowStartMs: start,
      windowEndMs: end,
      droppedCount,
      incompleteOperationCount,
      chunkIndex: index + 1,
      chunkCount: grouped.length,
      events: group,
    }));
    const totalBytes = chunks.reduce((total, chunk) => total + utf8ByteLength(chunk), 0);
    if (
      grouped.length <= SESSION_DIAGNOSTICS_LIMITS.maxChunks
      && totalBytes <= SESSION_DIAGNOSTICS_LIMITS.maxBytes
    ) {
      return { chunks, totalBytes, droppedEventCount };
    }
    // The oldest event is the first to leave the 60-second ring. If chunk
    // envelopes push a full report over its cap, drop from that same edge.
    const firstGeneralEvent = events.findIndex((event) => !isProtectedDiagnostic(event));
    events.splice(firstGeneralEvent === -1 ? 0 : firstGeneralEvent, 1);
    droppedEventCount += 1;
  }
  return { chunks: [], totalBytes: 0, droppedEventCount };
}

function isProtectedDiagnostic(event: DiagnosticEvent): boolean {
  return event.kind === 'native_crash' || event.kind === 'native_hang';
}

export function retainPendingReports(
  reports: readonly PendingDiagnosticReport[],
  nowMs: number,
): { reports: PendingDiagnosticReport[]; droppedCount: number } {
  let droppedCount = 0;
  const uniqueReports = new Map<string, PendingDiagnosticReport>();
  for (const report of reports) {
    if (report.expiresAtMs <= nowMs) {
      droppedCount += 1;
      continue;
    }
    const existing = uniqueReports.get(report.reportId);
    if (!existing || report.attemptCount > existing.attemptCount) {
      uniqueReports.set(report.reportId, report);
    }
  }
  let retained = [...uniqueReports.values()].sort(
    (left, right) => left.createdAtMs - right.createdAtMs,
  );

  const reportBytes = (report: PendingDiagnosticReport) =>
    report.chunks.reduce((total, chunk) => total + utf8ByteLength(chunk), 0);
  let totalBytes = retained.reduce((total, report) => total + reportBytes(report), 0);
  while (
    retained.length > SESSION_DIAGNOSTICS_LIMITS.maxPendingReports
    || totalBytes > SESSION_DIAGNOSTICS_LIMITS.maxPendingBytes
  ) {
    const removed = retained.shift();
    if (!removed) break;
    totalBytes -= reportBytes(removed);
    droppedCount += 1;
  }
  return { reports: retained, droppedCount };
}

export function prepareReportDispatch(
  report: PendingDiagnosticReport,
  nowMs: number,
): { report: PendingDiagnosticReport; chunks: string[] } | null {
  if (
    report.expiresAtMs <= nowMs
    || report.attemptCount >= SESSION_DIAGNOSTICS_LIMITS.maxDispatchAttempts
    || report.status !== 'pending'
  ) {
    return null;
  }
  const nextReport: PendingDiagnosticReport = {
    ...report,
    attemptCount: report.attemptCount + 1,
    status: 'dispatch_requested',
    lastDispatchRequestedAtMs: nowMs,
  };
  return { report: nextReport, chunks: [...report.chunks] };
}

export function markSdkCallFinishedUnconfirmed(
  report: PendingDiagnosticReport,
  nowMs: number,
): PendingDiagnosticReport {
  return {
    ...report,
    status: 'sdk_call_finished_unconfirmed',
    lastSdkCallFinishedAtMs: nowMs,
  };
}

export function reopenReportsAfterRestart(
  reports: readonly PendingDiagnosticReport[],
): PendingDiagnosticReport[] {
  return reports.map((report) => ({ ...report, status: 'pending' }));
}

function groupEvents(
  events: readonly DiagnosticEvent[],
  metadata: {
    reportId: string;
    appVersion: string;
    buildNumber: string;
    windowStartMs: number;
    windowEndMs: number;
    droppedCount: number;
    incompleteOperationCount: number;
  },
): { groups: DiagnosticEvent[][]; droppedEventCount: number } {
  const groups: DiagnosticEvent[][] = [];
  let current: DiagnosticEvent[] = [];
  let droppedEventCount = 0;
  for (const event of events) {
    const candidate = [...current, event];
    const serialized = serializeChunk({
      ...metadata,
      chunkIndex: groups.length + 1,
      chunkCount: SESSION_DIAGNOSTICS_LIMITS.maxChunks,
      events: candidate,
    });
    if (utf8ByteLength(serialized) <= SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes) {
      current = candidate;
    } else {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      const single = serializeChunk({
        ...metadata,
        chunkIndex: groups.length + 1,
        chunkCount: SESSION_DIAGNOSTICS_LIMITS.maxChunks,
        events: [event],
      });
      if (utf8ByteLength(single) <= SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes) {
        current = [event];
      } else {
        // Oversized single records (normally only an unexpectedly large native
        // diagnostic) are omitted rather than passed to SDK truncation.
        droppedEventCount += 1;
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return { groups, droppedEventCount };
}

function serializeChunk(input: {
  reportId: string;
  appVersion: string;
  buildNumber: string;
  windowStartMs: number;
  windowEndMs: number;
  droppedCount: number;
  incompleteOperationCount: number;
  chunkIndex: number;
  chunkCount: number;
  events: readonly DiagnosticEvent[];
}): string {
  return JSON.stringify({
    schema_version: 1,
    report_id: input.reportId,
    app_version: input.appVersion,
    build_number: input.buildNumber,
    window_start_ms: input.windowStartMs,
    window_end_ms: input.windowEndMs,
    prior_run_exit: 'unknown',
    dropped_count: input.droppedCount,
    incomplete_operation_count: input.incompleteOperationCount,
    chunk_index: input.chunkIndex,
    chunk_count: input.chunkCount,
    events: input.events,
  });
}

function safeVersion(value: string): string {
  return VERSION_PATTERN.test(value) ? value : 'unknown';
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? value as T : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
