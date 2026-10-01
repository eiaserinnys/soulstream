import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Constants as ExpoConstants } from 'expo-constants';
import { Platform } from 'react-native';
import type { SessionContextItem } from './planner-session-context';

export const SESSION_SUCCESSION_DIAGNOSTICS_KEY =
  'soul-app.session-succession-diagnostics.v1';
export const SESSION_START_DIAGNOSTIC_CONTEXT_KEY = 'session_start_diagnostic';

export type SessionSuccessionFailurePhase = 'render' | 'fallback' | 'nodes' | 'agents';

interface RuntimeFailureDetails {
  schemaVersion: 1;
  diagnosticId: string;
  occurredAt: string;
  error: {
    message: string;
    stack: string | null;
    componentStack: string | null;
  };
  app: {
    version: string | null;
    buildNumber: string | null;
  };
  device: {
    platform: string;
    platformVersion: string | null;
    modelName: string | null;
    modelIdentifier: string | null;
    interfaceIdiom: string | null;
  };
}

export interface SessionSuccessionFailureRecord extends RuntimeFailureDetails {
  folderId: string;
  folderPageId: string;
  projectPageId: string | null;
  phase: SessionSuccessionFailurePhase;
  screen: {
    visible: boolean;
    predecessorSessionId: string | null;
    folderBlockCount: number;
    folderSessionCount: number;
  };
}

export interface GlobalAppFailureRecord extends RuntimeFailureDetails {
  phase: 'global';
}

export type AppDiagnosticFailureRecord =
  | SessionSuccessionFailureRecord
  | GlobalAppFailureRecord;

export interface SessionDiagnosticDispatchState {
  targetSource: string;
  targetNodeId: string;
  targetAgentId: string;
  settingsNodeId: string | null;
}

interface SessionSuccessionDiagnosticOutbox {
  schemaVersion: 1;
  pending: AppDiagnosticFailureRecord[];
}

const MAX_PENDING_FAILURES = 10;
let writeQueue: Promise<void> = Promise.resolve();

export function createSessionSuccessionFailureRecord({
  folderId,
  folderPageId,
  projectPageId,
  phase,
  error,
  componentStack = null,
  occurredAt = new Date(),
  visible,
  predecessorSessionId,
  folderBlockCount,
  folderSessionCount,
}: {
  folderId: string;
  folderPageId: string;
  projectPageId: string | null;
  phase: SessionSuccessionFailurePhase;
  error: unknown;
  componentStack?: string | null;
  occurredAt?: Date;
  visible: boolean;
  predecessorSessionId: string | null;
  folderBlockCount: number;
  folderSessionCount: number;
}): SessionSuccessionFailureRecord {
  const runtime = captureRuntimeDetails();
  return {
    schemaVersion: 1,
    diagnosticId: `session-start:${folderId}:${phase}`,
    occurredAt: safeIsoString(occurredAt),
    folderId,
    folderPageId,
    projectPageId,
    phase,
    error: failureDetails(error, componentStack),
    app: runtime.app,
    device: runtime.device,
    screen: {
      visible,
      predecessorSessionId,
      folderBlockCount,
      folderSessionCount,
    },
  };
}

export function createGlobalAppFailureRecord(
  error: unknown,
  {
    componentStack = null,
    occurredAt = new Date(),
  }: {
    componentStack?: string | null;
    occurredAt?: Date;
  } = {},
): GlobalAppFailureRecord {
  const runtime = captureRuntimeDetails();
  const timestamp = safeIsoString(occurredAt);
  const resolvedComponentStack = componentStack ?? readErrorComponentStack(error);
  return {
    schemaVersion: 1,
    diagnosticId: `global:${timestamp}`,
    occurredAt: timestamp,
    phase: 'global',
    error: failureDetails(error, resolvedComponentStack),
    app: runtime.app,
    device: runtime.device,
  };
}

export function enqueueSessionSuccessionFailure(
  record: SessionSuccessionFailureRecord,
): Promise<void> {
  return enqueueDiagnosticFailure(record);
}

export function enqueueGlobalAppFailure(
  record: GlobalAppFailureRecord,
): Promise<void> {
  return enqueueDiagnosticFailure(record);
}

export async function readAppDiagnosticFailures(): Promise<AppDiagnosticFailureRecord[]> {
  return (await readOutbox()).pending;
}

export function formatAppDiagnosticFailures(
  records: readonly AppDiagnosticFailureRecord[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    records,
  }, null, 2);
}

function enqueueDiagnosticFailure(
  record: AppDiagnosticFailureRecord,
): Promise<void> {
  return queueStorageWrite(async () => {
    const current = await readOutbox();
    const pending = [
      ...current.pending.filter((candidate) => candidate.diagnosticId !== record.diagnosticId),
      record,
    ].slice(-MAX_PENDING_FAILURES);
    await AsyncStorage.setItem(
      SESSION_SUCCESSION_DIAGNOSTICS_KEY,
      JSON.stringify({ schemaVersion: 1, pending } satisfies SessionSuccessionDiagnosticOutbox),
    );
  });
}

export function clearSessionSuccessionFailure(diagnosticId: string): Promise<void> {
  return queueStorageWrite(async () => {
    const current = await readOutbox();
    const pending = current.pending.filter((record) => record.diagnosticId !== diagnosticId);
    if (pending.length === 0) {
      await AsyncStorage.removeItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
      return;
    }
    await AsyncStorage.setItem(
      SESSION_SUCCESSION_DIAGNOSTICS_KEY,
      JSON.stringify({ schemaVersion: 1, pending } satisfies SessionSuccessionDiagnosticOutbox),
    );
  });
}

export function buildSessionStartDiagnosticContextItem(
  record: SessionSuccessionFailureRecord,
  dispatch: SessionDiagnosticDispatchState,
): SessionContextItem {
  return {
    key: SESSION_START_DIAGNOSTIC_CONTEXT_KEY,
    label: '새 세션 시작 오류 진단',
    content: {
      schemaVersion: record.schemaVersion,
      occurredAt: record.occurredAt,
      phase: record.phase,
      error: record.error,
      scope: {
        folderId: record.folderId,
        folderPageId: record.folderPageId,
        projectPageId: record.projectPageId,
      },
      app: record.app,
      device: record.device,
      screen: { ...record.screen, ...dispatch },
    },
  };
}

function captureRuntimeDetails(): Pick<SessionSuccessionFailureRecord, 'app' | 'device'> {
  try {
    const Constants = require('expo-constants').default as ExpoConstants;
    const ios = Constants.platform?.ios;
    return {
      app: {
        version: nonEmptyString(Constants.expoConfig?.version),
        buildNumber: nonEmptyString(ios?.buildNumber)
          ?? nonEmptyString(Constants.expoConfig?.ios?.buildNumber),
      },
      device: {
        platform: Platform.OS,
        platformVersion: nonEmptyString(ios?.systemVersion)
          ?? scalarString(Platform.Version),
        modelName: nonEmptyString(ios?.model),
        modelIdentifier: nonEmptyString(ios?.platform),
        interfaceIdiom: nonEmptyString(ios?.userInterfaceIdiom),
      },
    };
  } catch (error) {
    safeWarn('[SessionSuccession] runtime diagnostics unavailable:', error);
    return {
      app: { version: null, buildNumber: null },
      device: {
        platform: 'unknown',
        platformVersion: null,
        modelName: null,
        modelIdentifier: null,
        interfaceIdiom: null,
      },
    };
  }
}

function failureDetails(
  error: unknown,
  componentStack: string | null,
): RuntimeFailureDetails['error'] {
  try {
    if (error instanceof Error) {
      return {
        message: safeString(error.message, '알 수 없는 JavaScript 오류'),
        stack: optionalString(error.stack),
        componentStack: optionalString(componentStack),
      };
    }
    return {
      message: safeString(error, '알 수 없는 JavaScript 오류'),
      stack: null,
      componentStack: optionalString(componentStack),
    };
  } catch {
    return {
      message: '오류 세부 정보를 읽지 못했습니다.',
      stack: null,
      componentStack: optionalString(componentStack),
    };
  }
}

function safeIsoString(value: Date): string {
  try {
    return value.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeString(value: unknown, fallback: string): string {
  try {
    const normalized = String(value).trim();
    return normalized || fallback;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value || null;
}

function readErrorComponentStack(error: unknown): string | null {
  try {
    if (!isRecord(error)) return null;
    return optionalString(error.componentStack);
  } catch {
    return null;
  }
}

function queueStorageWrite(operation: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue
    .then(operation)
    .catch((storageError) => {
      safeWarn('[SessionSuccession] diagnostic outbox update failed:', storageError);
    });
  return writeQueue;
}

async function readOutbox(): Promise<SessionSuccessionDiagnosticOutbox> {
  const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
  if (!raw) return { schemaVersion: 1, pending: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.pending)) {
      return { schemaVersion: 1, pending: [] };
    }
    return {
      schemaVersion: 1,
      pending: parsed.pending.filter(isFailureRecord),
    };
  } catch {
    return { schemaVersion: 1, pending: [] };
  }
}

function isFailureRecord(value: unknown): value is AppDiagnosticFailureRecord {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1
    || typeof value.diagnosticId !== 'string'
    || typeof value.occurredAt !== 'string'
    || !isRecord(value.error)
    || typeof value.error.message !== 'string'
  ) return false;
  if (value.phase === 'global') return true;
  return typeof value.folderId === 'string'
    && typeof value.folderPageId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function scalarString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return nonEmptyString(String(value));
}

function safeWarn(message: string, error: unknown) {
  try {
    console.warn(message, error);
  } catch {
    // 진단 로깅 자체가 진단 기록 생성·저장 경로를 깨뜨리지 않는다.
  }
}
