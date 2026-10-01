import { requireOptionalNativeModule } from 'expo-modules-core';

export interface NativeSessionDiagnosticRecord {
  id: string;
  processId: string;
  timestampMs: number;
  kind: string;
  source: string;
  operationId?: number;
  value?: number;
  phase?: string;
  state?: string;
  platform?: string;
  diagnosticType?: string;
  appVersion?: string;
  buildNumber?: string;
  durationMs?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  failed?: boolean;
  stackTruncated?: boolean;
  stackFrames?: Array<{
    binary: string;
    offset?: number;
    sampleCount?: number;
  }>;
}

export interface NativeSessionDiagnosticsModule {
  readPendingRecords(): Promise<string>;
  acknowledgeRecords(ids: string[]): Promise<boolean>;
  startMainThreadProbe(): void;
  stopMainThreadProbe(): void;
}

export const NativeSessionDiagnostics = requireOptionalNativeModule<NativeSessionDiagnosticsModule>(
  'SoulAppSessionDiagnostics',
);
