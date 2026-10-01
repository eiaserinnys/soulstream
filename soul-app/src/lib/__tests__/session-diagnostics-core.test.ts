import {
  BoundedDiagnosticsJournal,
  createReportChunks,
  normalizeDiagnosticEvent,
  markSdkCallFinishedUnconfirmed,
  prepareReportDispatch,
  retainPendingReports,
  reopenReportsAfterRestart,
  SESSION_DIAGNOSTICS_LIMITS,
  utf8ByteLength,
  type PendingDiagnosticReport,
} from '../session-diagnostics-core';

describe('session diagnostics core', () => {
  test('keeps only the approved recent window and bounds entries and serialized bytes', () => {
    const journal = new BoundedDiagnosticsJournal();
    journal.append({ timestampMs: 1_000, kind: 'route', source: 'feed' }, 61_001);

    for (let i = 0; i < 140; i += 1) {
      journal.append({
        timestampMs: 61_002 + i,
        kind: 'store_bucket',
        source: 'session',
        value: i,
      }, 61_002 + i);
    }

    const snapshot = journal.snapshot(61_200);
    expect(snapshot.events).toHaveLength(SESSION_DIAGNOSTICS_LIMITS.maxEntries);
    expect(snapshot.events.every((event) => event.timestampMs > 1_001)).toBe(true);
    expect(snapshot.byteLength).toBeLessThanOrEqual(SESSION_DIAGNOSTICS_LIMITS.maxBytes);
    expect(snapshot.droppedCount).toBe(12);
  });

  test('retains only fixed enums and numeric allowlisted fields', () => {
    const event = normalizeDiagnosticEvent({
      timestampMs: 12_000,
      kind: 'operation',
      source: 'secure_store',
      phase: 'end',
      value: 24.5,
      failed: false,
      operationId: 7,
      title: 'private title',
      taskId: 'private-id',
      eventData: 'private payload',
    });

    expect(event).toEqual({
      timestampMs: 12_000,
      kind: 'operation',
      source: 'secure_store',
      phase: 'end',
      value: 24.5,
      failed: false,
      operationId: 7,
    });
    expect(JSON.stringify(event)).not.toMatch(/private|taskId|eventData/);
    expect(normalizeDiagnosticEvent({
      timestampMs: 12_001,
      kind: 'route',
      source: 'private-route-name',
    })?.source).toBe('other');
  });

  test('reduces oversized MetricKit stacks to bounded binary classes and numeric offsets', () => {
    const event = normalizeDiagnosticEvent({
      timestampMs: 12_000,
      kind: 'native_hang',
      source: 'metrickit',
      diagnosticType: 'hang',
      appVersion: '1.0.0',
      buildNumber: '121',
      osVersion: '17.0.1(21A329)',
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      stackFrames: Array.from({ length: 200 }, (_, index) => ({
        binary: index === 0 ? 'uikit' : '/private/path/SomeBinary',
        binaryUuid: index === 0
          ? '70B89F27-1634-3580-A695-57CDB41D7743'
          : '/private/path/uuid',
        offset: index,
        sampleCount: 1,
        functionName: 'private-function-name',
      })),
      rawPayload: { callStacks: ['private'] },
    });

    expect(event?.stackFrames).toHaveLength(1);
    expect(event?.stackFrames?.[0]).toEqual({
      binary: 'uikit',
      binaryUuid: '70b89f27-1634-3580-a695-57cdb41d7743',
      offset: 0,
      sampleCount: 1,
    });
    expect(event?.osVersion).toBe('17.0.1(21A329)');
    expect(JSON.stringify(event)).toContain('70b89f27-1634-3580-a695-57cdb41d7743');
    expect(JSON.stringify(event)).not.toMatch(/private|rawPayload|functionName|imageUuid|address/);

    const unsafeOsVersion = normalizeDiagnosticEvent({
      timestampMs: 12_005,
      kind: 'native_hang',
      source: 'metrickit',
      osVersion: '17.0.1 (21A329) /private/path',
    });
    expect(unsafeOsVersion?.osVersion).toBeUndefined();
    const oversizedOsVersion = normalizeDiagnosticEvent({
      timestampMs: 12_006,
      kind: 'native_hang',
      source: 'metrickit',
      osVersion: '9'.repeat(3_000),
    });
    expect(oversizedOsVersion?.osVersion).toBeUndefined();

    const largeSafeStack = normalizeDiagnosticEvent({
      timestampMs: 12_001,
      kind: 'native_hang',
      source: 'metrickit',
      stackFrames: Array.from({ length: 200 }, (_, index) => ({
        binary: 'uikit',
        binaryUuid: '70B89F27-1634-3580-A695-57CDB41D7743',
        offset: index,
        sampleCount: 1,
      })),
    });
    expect(largeSafeStack?.stackFrames).toHaveLength(SESSION_DIAGNOSTICS_LIMITS.maxStackFrames);
    expect(largeSafeStack?.stackTruncated).toBe(true);
    expect(largeSafeStack?.stackFrames?.[0].binaryUuid).toBe('70b89f27-1634-3580-a695-57cdb41d7743');

    const unknownBinary = normalizeDiagnosticEvent({
      timestampMs: 12_002,
      kind: 'native_hang',
      source: 'metrickit',
      stackFrames: [{
        binary: 'other',
        binaryUuid: '70B89F27-1634-3580-A695-57CDB41D7743',
      }],
    });
    expect(unknownBinary?.stackFrames?.[0]).toEqual({
      binary: 'other',
      binaryUuid: '70b89f27-1634-3580-a695-57cdb41d7743',
    });

    const malformedUuid = normalizeDiagnosticEvent({
      timestampMs: 12_003,
      kind: 'native_hang',
      source: 'metrickit',
      stackFrames: [{ binary: 'uikit', binaryUuid: '/private/path/uuid' }],
    });
    expect(malformedUuid?.stackFrames?.[0]).toEqual({ binary: 'uikit' });

    const outOfRangeOffset = normalizeDiagnosticEvent({
      timestampMs: 12_004,
      kind: 'native_hang',
      source: 'metrickit',
      stackFrames: [{ binary: 'soul_app', offset: Number.MAX_SAFE_INTEGER + 1 }],
    });
    expect(outOfRangeOffset?.stackFrames?.[0]).toEqual({ binary: 'soul_app' });
  });

  test('keeps a maximum allowlisted MetricKit stack inside one Observe chunk', () => {
    const result = createReportChunks({
      reportId: '00000000-0000-4000-8000-000000000001',
      appVersion: '1'.repeat(32),
      buildNumber: '2'.repeat(32),
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      droppedCount: 0,
      incompleteOperationCount: 0,
      events: [{
        timestampMs: 2_000,
        diagnosticId: '00000000-0000-4000-8000-000000000002',
        appVersion: '1'.repeat(32),
        buildNumber: '2'.repeat(32),
        osVersion: '999.999.999.999(ABCDEFGHIJKLMNOP)',
        kind: 'native_hang',
        source: 'metrickit',
        diagnosticType: 'hang',
        windowStartMs: 1_000,
        windowEndMs: 2_000,
        durationMs: Number.MAX_VALUE,
        stackFrames: Array.from({ length: SESSION_DIAGNOSTICS_LIMITS.maxStackFrames }, () => ({
          binary: 'core_foundation',
          binaryUuid: '70b89f27-1634-3580-a695-57cdb41d7743',
          offset: Number.MAX_SAFE_INTEGER,
          sampleCount: Number.MAX_SAFE_INTEGER,
        })),
      }],
    });

    expect(result.chunks).toHaveLength(1);
    expect(utf8ByteLength(result.chunks[0])).toBeLessThanOrEqual(
      SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes,
    );
    const payload = JSON.parse(result.chunks[0]);
    expect(payload.events).toHaveLength(1);
    expect(payload.dropped_count).toBe(0);
  });

  test('keeps crash metadata and the extended crash stack through report bounds', () => {
    const crash = {
      timestampMs: 1_700_000_000_000,
      diagnosticId: '00000000-0000-4000-8000-000000000002',
      kind: 'native_crash',
      source: 'metrickit',
      diagnosticType: 'crash',
      terminationReason: '<RBSTerminateContext| domain:10 code:0x8BADF00D explanation:scene-update watchdog transgression: app<com.soulstream(12345678-1234-1234-1234-1234567890ab)>:1363 exhausted real (wall clock) time allowance of 10.00 seconds\nProcessVisibility: Background',
      exceptionType: 10,
      signal: 9,
      stackFrames: Array.from({ length: 20 }, (_, index) => ({
        binary: 'react_native',
        binaryUuid: '70b89f27-1634-3580-a695-57cdb41d7743',
        offset: index * 64,
        sampleCount: 1,
      })),
    };
    const result = createReportChunks({
      reportId: '00000000-0000-4000-8000-000000000001',
      appVersion: '1.0.0',
      buildNumber: '123',
      windowStartMs: crash.timestampMs,
      windowEndMs: crash.timestampMs,
      events: [
        crash,
        ...Array.from({ length: 500 }, (_, index) => ({
          timestampMs: crash.timestampMs + index + 1,
          kind: 'operation',
          source: 'async_storage',
          phase: 'end',
          operationId: index + 1,
          value: 100 + index,
        })),
      ],
    });

    const reportedEvents = result.chunks.flatMap((chunk) => JSON.parse(chunk).events);
    const reportedCrash = reportedEvents.find((event: { kind: string }) => event.kind === 'native_crash');
    expect(reportedCrash).toMatchObject({
      diagnosticType: 'crash',
      terminationReason: crash.terminationReason.split('\n')[0],
      exceptionType: 10,
      signal: 9,
    });
    expect(reportedCrash.stackFrames).toHaveLength(20);
    expect(reportedCrash.stackFrames[0]).toMatchObject({
      binary: 'react_native',
      binaryUuid: '70b89f27-1634-3580-a695-57cdb41d7743',
      offset: 0,
    });
    expect(result.droppedEventCount).toBeGreaterThan(0);
  });

  test('SSE lifecycle counters are fixed numeric fields', () => {
    const event = normalizeDiagnosticEvent({
      timestampMs: 12_000,
      kind: 'sse_bucket',
      source: 'feed_stream',
      sseOpenCount: 2,
      sseCloseCount: 1,
      sseErrorCount: 3,
      url: 'https://private.example/session',
    });

    expect(event).toMatchObject({
      sseOpenCount: 2,
      sseCloseCount: 1,
      sseErrorCount: 3,
    });
    expect(JSON.stringify(event)).not.toContain('private.example');
  });

  test('chunks one logical report below the installed SDK body cap with stable identifiers', () => {
    const events = Array.from({ length: 128 }, (_, index) => ({
      timestampMs: 1_700_000_000_000 + index,
      kind: 'operation' as const,
      source: 'async_storage' as const,
      phase: 'end' as const,
      value: 250 + index,
      operationId: index + 1,
    }));

    const result = createReportChunks({
      reportId: '8c0c0d5d-0fbd-4aa1-8717-735609527381',
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: 1_700_000_000_000,
      windowEndMs: 1_700_000_060_000,
      events,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.length).toBeLessThanOrEqual(SESSION_DIAGNOSTICS_LIMITS.maxChunks);
    for (const chunk of result.chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
        SESSION_DIAGNOSTICS_LIMITS.maxChunkBodyBytes,
      );
      const parsed = JSON.parse(chunk);
      expect(parsed.report_id).toBe('8c0c0d5d-0fbd-4aa1-8717-735609527381');
      expect(parsed.prior_run_exit).toBe('unknown');
      expect(parsed.events.length).toBeGreaterThan(0);
    }
    expect(result.totalBytes).toBeLessThanOrEqual(SESSION_DIAGNOSTICS_LIMITS.maxBytes);
  });

  test('bounds pending reports and drops expired reports explicitly', () => {
    const makeReport = (reportId: string, createdAtMs: number): PendingDiagnosticReport => ({
      reportId,
      createdAtMs,
      expiresAtMs: createdAtMs + SESSION_DIAGNOSTICS_LIMITS.reportTtlMs,
      attemptCount: 0,
      status: 'pending',
      chunks: ['{"events":[]}'],
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: createdAtMs,
      windowEndMs: createdAtMs,
    });

    const result = retainPendingReports([
      makeReport('old', 1),
      makeReport('r2', 2),
      makeReport('r3', 3),
      makeReport('r4', 4),
    ], 5);

    expect(result.reports).toHaveLength(SESSION_DIAGNOSTICS_LIMITS.maxPendingReports);
    expect(result.reports.map((report) => report.reportId)).toEqual(['r2', 'r3', 'r4']);
    expect(result.droppedCount).toBe(1);

    const expired = retainPendingReports([makeReport('expired', 1)], 1 + SESSION_DIAGNOSTICS_LIMITS.reportTtlMs);
    expect(expired.reports).toEqual([]);
    expect(expired.droppedCount).toBe(1);
  });

  test('requests at most three dispatch attempts and keeps stable report id across retry', () => {
    const report: PendingDiagnosticReport = {
      reportId: '2e8eaa7d-7dae-45f3-8e86-cc29fba2a0c8',
      createdAtMs: 10,
      expiresAtMs: 100_000,
      attemptCount: 0,
      status: 'pending',
      chunks: ['{"events":[{"kind":"route","source":"feed"}]}'],
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: 10,
      windowEndMs: 20,
    };

    const first = prepareReportDispatch(report, 20);
    expect(first?.report).toMatchObject({
      reportId: report.reportId,
      attemptCount: 1,
      status: 'dispatch_requested',
    });
    const second = prepareReportDispatch({ ...first!.report, status: 'pending' }, 30);
    const third = prepareReportDispatch({ ...second!.report, status: 'pending' }, 40);
    const fourth = prepareReportDispatch({ ...third!.report, status: 'pending' }, 50);

    expect(second?.report.reportId).toBe(report.reportId);
    expect(third?.report.attemptCount).toBe(3);
    expect(fourth).toBeNull();
  });

  test('reopens a settled SDK dispatch request after restart without claiming remote receipt', () => {
    const requested: PendingDiagnosticReport = {
      reportId: '2e8eaa7d-7dae-45f3-8e86-cc29fba2a0c8',
      createdAtMs: 10,
      expiresAtMs: 100_000,
      attemptCount: 2,
      status: 'sdk_call_finished_unconfirmed',
      chunks: ['{"report_id":"same","chunk_index":1}'],
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: 10,
      windowEndMs: 20,
      lastSdkCallFinishedAtMs: 30,
    };

    const recovered = reopenReportsAfterRestart([requested]);
    expect(recovered[0]).toMatchObject({
      reportId: requested.reportId,
      attemptCount: 2,
      status: 'pending',
    });
    expect(recovered[0].lastSdkCallFinishedAtMs).toBe(30);
  });

  test('deduplicates a report written before journal rollover interrupted by restart', () => {
    const report: PendingDiagnosticReport = {
      reportId: '2e8eaa7d-7dae-45f3-8e86-cc29fba2a0c8',
      createdAtMs: 10,
      expiresAtMs: 100_000,
      attemptCount: 1,
      status: 'sdk_call_finished_unconfirmed',
      chunks: ['{"report_id":"same"}'],
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: 10,
      windowEndMs: 20,
    };

    const result = retainPendingReports([report, { ...report, attemptCount: 0 }], 20);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].attemptCount).toBe(1);
    expect(result.droppedCount).toBe(0);
  });

  test('marks SDK Promise completion as remote-unconfirmed state', () => {
    const report: PendingDiagnosticReport = {
      reportId: '2e8eaa7d-7dae-45f3-8e86-cc29fba2a0c8',
      createdAtMs: 10,
      expiresAtMs: 100_000,
      attemptCount: 1,
      status: 'dispatch_requested',
      chunks: ['{"events":[]}'],
      appVersion: '1.0.0',
      buildNumber: '121',
      windowStartMs: 10,
      windowEndMs: 20,
    };

    expect(markSdkCallFinishedUnconfirmed(report, 30)).toMatchObject({
      status: 'sdk_call_finished_unconfirmed',
      lastSdkCallFinishedAtMs: 30,
    });
    expect(JSON.stringify(report)).not.toContain('remote_receipt_confirmed');
  });
});
