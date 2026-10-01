import {
  createGlobalAppFailureRecord,
  enqueueGlobalAppFailure,
} from './session-succession-diagnostics';
import { useAppNoticeStore } from '../store/appNoticeStore';

export type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

interface InstallOptions {
  errorUtils?: ErrorUtilsLike | null;
  isDev?: boolean;
  /**
   * An error handler captured before a third-party module installs its own
   * wrapper. Passing this preserves React Native handling without chaining a
   * telemetry module that might serialize the original exception.
   */
  previousHandler?: GlobalErrorHandler;
  /** Optional side channel for a deliberately sanitized error representation. */
  reportError?: (error: unknown, isFatal: boolean) => void;
  log?: (message: string, error: unknown) => void;
}

const installedTargets = new WeakSet<object>();

export function installProductionGlobalErrorHandler({
  errorUtils = resolveErrorUtils(),
  isDev = typeof __DEV__ !== 'undefined' && __DEV__,
  previousHandler,
  reportError,
  log = (message, error) => console.error(message, error),
}: InstallOptions = {}): boolean {
  if (isDev || !errorUtils || installedTargets.has(errorUtils)) return false;

  let previous = previousHandler;
  if (!previous) {
    try {
      previous = errorUtils.getGlobalHandler();
    } catch (error) {
      safeLog(log, '[GlobalErrorHandler] default handler lookup failed:', error);
      return false;
    }
  }

  const handler: GlobalErrorHandler = (error, isFatal = false) => {
    try {
      reportError?.(error, isFatal);
    } catch (reportingError) {
      safeLog(log, '[GlobalErrorHandler] sanitized error reporting failed:', reportingError);
    }

    if (!isFatal) {
      previous(error, isFatal);
      return;
    }

    try {
      const record = createGlobalAppFailureRecord(error);
      void enqueueGlobalAppFailure(record);
    } catch (diagnosticError) {
      safeLog(log, '[GlobalErrorHandler] fatal diagnostic persistence failed:', diagnosticError);
    }

    safeLog(
      log,
      '[GlobalErrorHandler] fatal JavaScript error isolated:',
      new Error('details retained in local diagnostics'),
    );

    try {
      useAppNoticeStore.getState().showNotice({
        tone: 'error',
        title: '앱 오류를 복구했습니다.',
        message: '설정의 앱 진단 기록에서 오류 내용을 확인할 수 있습니다.',
      });
    } catch (noticeError) {
      safeLog(log, '[GlobalErrorHandler] fatal notice failed:', noticeError);
    }
  };
  try {
    errorUtils.setGlobalHandler(handler);
  } catch (error) {
    safeLog(log, '[GlobalErrorHandler] handler installation failed:', error);
    return false;
  }
  installedTargets.add(errorUtils);
  return true;
}

export function isProductionGlobalErrorHandlerInstalled(
  errorUtils: ErrorUtilsLike,
): boolean {
  return installedTargets.has(errorUtils);
}

function resolveErrorUtils(): ErrorUtilsLike | null {
  const runtime = globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsLike };
  return runtime.ErrorUtils ?? null;
}

function safeLog(
  log: (message: string, error: unknown) => void,
  message: string,
  error: unknown,
) {
  try {
    log(message, error);
  } catch {
    // 전역 fatal 처리 자체는 어떤 진단 부가기능 실패에도 다시 throw하지 않는다.
  }
}
