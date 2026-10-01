import type { DiagnosticSource, ModalDiagnosticSource } from './session-diagnostics-core';
import type { DiagnosticOperation } from './session-diagnostics-runtime';

export const DIAGNOSTIC_STORAGE_OPERATION = Object.freeze({
  read: 20,
  write: 21,
  remove: 22,
});

export interface SessionDiagnosticsSink {
  recordRoute(source: DiagnosticSource): void;
  recordModal(
    source: ModalDiagnosticSource,
    variant: 'compact' | 'expanded' | 'popover',
    visible: boolean,
  ): void;
  recordSseConnection(
    source: Extract<DiagnosticSource, 'node_stream' | 'feed_stream' | 'chat_stream'>,
    state: 'open' | 'close' | 'error',
  ): void;
  recordSseMessage(source: DiagnosticSource, bytes: number): void;
  recordStoreUpdate(source: DiagnosticSource): void;
  recordFeedRender(durationMs: number): void;
  beginOperation(source: DiagnosticSource, operationCode: number): DiagnosticOperation;
  endOperation(
    source: DiagnosticSource,
    operationCode: number,
    operation: DiagnosticOperation,
    failed?: boolean,
  ): void;
}

let diagnosticsSink: SessionDiagnosticsSink | null = null;

export function bindSessionDiagnosticsSink(sink: SessionDiagnosticsSink | null): void {
  diagnosticsSink = sink;
}

export function recordStaticRoute(source: DiagnosticSource): void {
  safeCall(() => diagnosticsSink?.recordRoute(source));
}

export function recordModalVisibility(
  source: ModalDiagnosticSource,
  variant: 'compact' | 'expanded' | 'popover',
  visible: boolean,
): void {
  safeCall(() => diagnosticsSink?.recordModal(source, variant, visible));
}

export function recordSseConnection(
  source: Extract<DiagnosticSource, 'node_stream' | 'feed_stream' | 'chat_stream'>,
  state: 'open' | 'close' | 'error',
): void {
  safeCall(() => diagnosticsSink?.recordSseConnection(source, state));
}

export function recordSseMessageBytes(source: DiagnosticSource, bytes: number): void {
  safeCall(() => diagnosticsSink?.recordSseMessage(source, bytes));
}

export function recordStoreUpdateCount(source: DiagnosticSource): void {
  safeCall(() => diagnosticsSink?.recordStoreUpdate(source));
}

export function recordFeedCommit(durationMs: number): void {
  safeCall(() => diagnosticsSink?.recordFeedRender(durationMs));
}

export function beginDiagnosticOperation(
  source: DiagnosticSource,
  operationCode: number,
): DiagnosticOperation | null {
  try {
    return diagnosticsSink?.beginOperation(source, operationCode) ?? null;
  } catch {
    return null;
  }
}

export function endDiagnosticOperation(
  source: DiagnosticSource,
  operationCode: number,
  operation: DiagnosticOperation | null,
  failed = false,
): void {
  if (!operation) return;
  safeCall(() => diagnosticsSink?.endOperation(source, operationCode, operation, failed));
}

export function measureDiagnosticOperation<T>(
  source: DiagnosticSource,
  operationCode: number,
  operation: () => T,
): T {
  const marker = beginDiagnosticOperation(source, operationCode);
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          endDiagnosticOperation(source, operationCode, marker);
          return value;
        },
        (error) => {
          endDiagnosticOperation(source, operationCode, marker, true);
          throw error;
        },
      ) as T;
    }
    endDiagnosticOperation(source, operationCode, marker);
    return result;
  } catch (error) {
    endDiagnosticOperation(source, operationCode, marker, true);
    throw error;
  }
}

function safeCall(callback: () => void | undefined): void {
  try {
    callback();
  } catch {
    // Instrumentation must never perturb the path it observes.
  }
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
