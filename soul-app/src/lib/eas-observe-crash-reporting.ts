import {
  installProductionGlobalErrorHandler,
  isProductionGlobalErrorHandlerInstalled,
  type ErrorUtilsLike,
  type GlobalErrorHandler,
} from './global-error-handler';

export type ObservedErrorSource =
  | 'global-fatal'
  | 'global-nonfatal'
  | 'session-succession-render'
  | 'session-succession-fallback'
  | 'glass-surface-role';

type HandledObservedErrorSource = Exclude<
  ObservedErrorSource,
  'global-fatal' | 'global-nonfatal'
>;

type AppMetricsGlobalError = {
  source: 'global';
  type: string;
  message: string;
  stacktrace?: string;
  isFatal: boolean;
};

type ObserveLike = {
  Observe: {
    configure(config: ObservePrivacyConfig): void;
    reportError(error: unknown): void;
    logEvent?: (name: string, options?: { body?: string; attributes?: Record<string, string> }) => void;
    dispatchEvents?: () => Promise<void>;
  };
  AppMetrics: {
    reportError(error: AppMetricsGlobalError): void;
  };
};

type ObservePrivacyConfig = {
  integrations: {
    'expo-router': false;
    'react-navigation': false;
  };
};

const OBSERVE_PRIVACY_CONFIG: ObservePrivacyConfig = {
  // The installed SDK defaults both integrations to false. Set that policy
  // explicitly so a future SDK-default change cannot export route/session data.
  integrations: {
    'expo-router': false,
    'react-navigation': false,
  },
};

type ObservedErrorReporter = (error: unknown, source: ObservedErrorSource) => void;

interface InstallEasObserveCrashReportingOptions {
  errorUtils?: ErrorUtilsLike | null;
  isDev?: boolean;
  loadObserve?: () => ObserveLike;
  log?: (message: string, error: unknown) => void;
}

let observedErrorReporter: ObservedErrorReporter | null = null;
let configuredObserve: ObserveLike | null = null;
let observeDispatchQueue: Promise<void> = Promise.resolve();

/**
 * Installs the production EAS Observe bridge without letting its automatic
 * ErrorUtils wrapper serialize application exception contents. `expo-observe`
 * is intentionally loaded only after the original RN handler is captured.
 */
export function installEasObserveCrashReporting({
  errorUtils = resolveErrorUtils(),
  isDev = typeof __DEV__ !== 'undefined' && __DEV__,
  loadObserve = loadObserveModule,
  log = (message, error) => console.error(message, error),
}: InstallEasObserveCrashReportingOptions = {}): boolean {
  // A development build keeps the pre-existing RN red-box path completely
  // untouched. Release builds dispatch by default; debug dispatch is not needed
  // for the production verification planned for this integration.
  if (isDev || !errorUtils || isProductionGlobalErrorHandlerInstalled(errorUtils)) {
    return false;
  }

  let originalHandler: GlobalErrorHandler;
  try {
    originalHandler = errorUtils.getGlobalHandler();
  } catch (error) {
    safeLog(log, '[EasObserve] original ErrorUtils handler lookup failed:', error);
    return false;
  }

  // A failed re-install must not leave an earlier reporter associated with a
  // different ErrorUtils target. The normal already-installed path returned
  // above before clearing this reference.
  observedErrorReporter = null;
  configuredObserve = null;

  let observe: ObserveLike;
  try {
    // Importing expo-observe synchronously installs its raw global ErrorUtils
    // wrapper. The next call replaces that wrapper with the sanitized bridge.
    observe = loadObserve();
  } catch (error) {
    safeLog(log, '[EasObserve] module load failed:', error);
    return fallbackToLocalRecovery(errorUtils, originalHandler, log);
  }
  if (!isObserveLike(observe)) {
    safeLog(log, '[EasObserve] module did not expose required Observe APIs:', observe);
    return fallbackToLocalRecovery(errorUtils, originalHandler, log);
  }

  try {
    observe.Observe.configure(OBSERVE_PRIVACY_CONFIG);
  } catch (error) {
    safeLog(log, '[EasObserve] privacy configuration failed:', error);
    return fallbackToLocalRecovery(errorUtils, originalHandler, log);
  }

  const reporter: ObservedErrorReporter = (error, source) => {
    const observed = createSanitizedObservedError(error, source);
    if (usesAppMetricsGlobalErrorReport(source)) {
      // Observe.reportError deliberately labels every record as a handled,
      // non-fatal `reportedByUser` error. The installed AppMetrics bridge is
      // the only path that retains the original global/fatal classification.
      observe.AppMetrics.reportError({
        source: 'global',
        type: observed.name,
        message: observed.message,
        stacktrace: observed.stack,
        isFatal: source === 'global-fatal',
      });
      return;
    }
    observe.Observe.reportError(observed);
  };
  const installed = installProductionGlobalErrorHandler({
    errorUtils,
    isDev: false,
    previousHandler: originalHandler,
    reportError: (error, isFatal) => {
      reporter(error, isFatal ? 'global-fatal' : 'global-nonfatal');
    },
    log,
  });
  if (!installed) {
    return fallbackToLocalRecovery(errorUtils, originalHandler, log);
  }

  observedErrorReporter = reporter;
  configuredObserve = observe;
  requestEasObserveStartupDispatch(observe, log);
  return true;
}

/** Records an already-sanitized bounded payload as an attribute visible in CLI properties. */
export function logEasObserveEvent(name: string, body: string): boolean {
  const logEvent = configuredObserve?.Observe.logEvent;
  if (typeof logEvent !== 'function') return false;
  try {
    // eas-cli@24.7.0 observe:events returns `properties` but omits the event
    // body. Keep the bounded payload in one fixed attribute so authenticated
    // CLI queries can inspect and reassemble reports.
    logEvent.call(configuredObserve?.Observe, name, {
      attributes: { soul_app_diagnostics_payload: body },
    });
    return true;
  } catch {
    return false;
  }
}

/** Serializes dispatch requests so startup and diagnostics do not race SDK cursors. */
export function dispatchEasObserveEvents(): Promise<void> {
  const observe = configuredObserve;
  const dispatchEvents = observe?.Observe.dispatchEvents;
  if (!observe || typeof dispatchEvents !== 'function') {
    return Promise.reject(new Error('EAS Observe dispatch is unavailable'));
  }
  const nextDispatch = observeDispatchQueue.then(() => dispatchEvents.call(observe.Observe));
  observeDispatchQueue = nextDispatch.catch(() => undefined);
  return nextDispatch;
}

/**
 * Reports only the synthesized representation used by the global bridge. This
 * is for handled render paths which never reach React Native's ErrorUtils.
 */
export function reportSanitizedEasObserveError(
  error: unknown,
  source: HandledObservedErrorSource,
): void {
  try {
    observedErrorReporter?.(error, source);
  } catch {
    // Observability must never break the error recovery UI it accompanies.
  }
}

/**
 * Creates a fresh Error instead of mutating or forwarding the original one.
 * Its message and stack are built exclusively from a fixed source/category and
 * a tightly allowed production-bundle location format.
 */
export function createSanitizedObservedError(
  error: unknown,
  source: ObservedErrorSource,
): Error {
  const safeSource = isObservedErrorSource(source) ? source : 'global-nonfatal';
  const category = classifyError(error);
  const message = `soul-app.${safeSource}.${category}`;
  const observed = new Error(message);
  observed.name = 'SoulAppObservedError';
  setObservedStack(observed, message, sanitizeStack(error));
  return observed;
}

function loadObserveModule(): ObserveLike {
  // Do not turn this into a static import. The capture-before-import ordering is
  // what prevents expo-app-metrics' automatic ErrorUtils handler from seeing
  // raw message, stack, session id, or response-body content.
  return require('expo-observe') as ObserveLike;
}

/**
 * Requests one flush after the privacy configuration and sanitized ErrorUtils
 * bridge are fully installed. This can send records that were already persisted
 * before JavaScript started, but does not claim to flush a MetricKit callback
 * that arrives later in the current process.
 */
function requestEasObserveStartupDispatch(
  observe: ObserveLike,
  log: (message: string, error: unknown) => void,
): void {
  const dispatchEvents = observe.Observe.dispatchEvents;
  if (typeof dispatchEvents !== 'function') return;

  try {
    const nextDispatch = observeDispatchQueue.then(() => dispatchEvents.call(observe.Observe));
    observeDispatchQueue = nextDispatch.catch(() => undefined);
    void nextDispatch.catch(() => {
      safeLog(
        log,
        '[EasObserve] startup dispatch failed:',
        new Error('details intentionally omitted'),
      );
    });
  } catch {
    safeLog(
      log,
      '[EasObserve] startup dispatch failed:',
      new Error('details intentionally omitted'),
    );
  }
}

function resolveErrorUtils(): ErrorUtilsLike | null {
  const runtime = globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsLike };
  return runtime.ErrorUtils ?? null;
}

function isObserveLike(value: unknown): value is ObserveLike {
  try {
    return typeof (value as ObserveLike | null)?.Observe?.configure === 'function'
      && typeof (value as ObserveLike | null)?.Observe?.reportError === 'function'
      && typeof (value as ObserveLike | null)?.AppMetrics?.reportError === 'function';
  } catch {
    return false;
  }
}

function fallbackToLocalRecovery(
  errorUtils: ErrorUtilsLike,
  originalHandler: GlobalErrorHandler,
  log: (message: string, error: unknown) => void,
): false {
  // expo-app-metrics installs its raw handler as an import side effect. Always
  // remove it before activating our local recovery path so an import/configure
  // failure cannot serialize an original message or stack to Observe.
  restoreOriginalHandler(errorUtils, originalHandler, log);
  const installed = installProductionGlobalErrorHandler({
    errorUtils,
    isDev: false,
    previousHandler: originalHandler,
    log,
  });
  if (!installed) restoreOriginalHandler(errorUtils, originalHandler, log);
  return false;
}

function restoreOriginalHandler(
  errorUtils: ErrorUtilsLike,
  originalHandler: GlobalErrorHandler,
  log: (message: string, error: unknown) => void,
) {
  try {
    errorUtils.setGlobalHandler(originalHandler);
  } catch (error) {
    safeLog(log, '[EasObserve] ErrorUtils handler restoration failed:', error);
  }
}

function safeLog(
  log: (message: string, error: unknown) => void,
  message: string,
  error: unknown,
) {
  try {
    log(message, error);
  } catch {
    // Nothing here is allowed to perturb the RN crash/recovery path.
  }
}

function classifyError(error: unknown): string {
  const status = safeApiHttpStatus(error);
  if (status !== null) return `api-http-${status}`;
  if (error instanceof Error) return 'error';
  if (error === null) return 'thrown-null';
  switch (typeof error) {
    case 'string':
      return 'thrown-string';
    case 'number':
      return 'thrown-number';
    case 'boolean':
      return 'thrown-boolean';
    case 'bigint':
      return 'thrown-bigint';
    case 'symbol':
      return 'thrown-symbol';
    case 'function':
      return 'thrown-function';
    default:
      return 'thrown-object';
  }
}

function safeApiHttpStatus(error: unknown): number | null {
  try {
    if (!(error instanceof Error) || error.name !== 'ApiHttpError') return null;
    const status = (error as Error & { status?: unknown }).status;
    if (
      typeof status !== 'number'
      || !Number.isInteger(status)
      || status < 100
      || status > 599
    ) return null;
    return status;
  } catch {
    return null;
  }
}

function sanitizeStack(error: unknown): string[] {
  let stack: unknown;
  try {
    stack = error instanceof Error ? error.stack : undefined;
  } catch {
    return [];
  }
  if (typeof stack !== 'string') return [];

  const frames: string[] = [];
  for (const line of stack.split(/\r?\n/).slice(1)) {
    const frame = sanitizeStackFrame(line);
    if (frame) frames.push(frame);
    if (frames.length === 5) break;
  }
  return frames;
}

function sanitizeStackFrame(line: string): string | null {
  // URL query/fragment material is always rejected rather than redacted. This
  // keeps an attacker-controlled source string from becoming observability data.
  if (line.includes('?') || line.includes('#')) return null;
  const match = line.trim().match(
    /(?:^|\()(?<address>address at )?(?:[^()\s]*\/)*(?<bundle>index(?:\.(?:ios|android))?\.bundle|main\.jsbundle):(?<line>\d+):(?<column>\d+)\)?$/,
  );
  if (!match?.groups) return null;
  const address = match.groups.address ?? '';
  return `at <frame> (${address}${match.groups.bundle}:${match.groups.line}:${match.groups.column})`;
}

function setObservedStack(observed: Error, message: string, frames: readonly string[]) {
  const stack = [`SoulAppObservedError: ${message}`, ...frames].join('\n');
  try {
    Object.defineProperty(observed, 'stack', {
      value: stack,
      configurable: true,
      writable: true,
    });
  } catch {
    try {
      observed.stack = stack;
    } catch {
      // The Error constructor's own stack contains only this synthetic error.
    }
  }
}

function isObservedErrorSource(value: string): value is ObservedErrorSource {
  return value === 'global-fatal'
    || value === 'global-nonfatal'
    || value === 'session-succession-render'
    || value === 'session-succession-fallback'
    || value === 'glass-surface-role';
}

function usesAppMetricsGlobalErrorReport(
  source: ObservedErrorSource,
): source is 'global-fatal' | 'global-nonfatal' {
  return source === 'global-fatal'
    || source === 'global-nonfatal';
}
