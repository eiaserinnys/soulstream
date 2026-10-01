import AsyncStorage from '@react-native-async-storage/async-storage';
import { waitFor } from '@testing-library/react-native';
import { useAppNoticeStore } from '../../store/appNoticeStore';
import { SESSION_SUCCESSION_DIAGNOSTICS_KEY } from '../session-succession-diagnostics';
import {
  createSanitizedObservedError,
  installEasObserveCrashReporting,
  logEasObserveEvent,
  reportSanitizedEasObserveError,
} from '../eas-observe-crash-reporting';
import type { ErrorUtilsLike } from '../global-error-handler';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '1.0.0', ios: { buildNumber: '90' } },
    platform: { ios: { buildNumber: '90' } },
  },
}));

function createErrorUtils() {
  const original = jest.fn();
  let handler: ReturnType<ErrorUtilsLike['getGlobalHandler']> = original;
  const errorUtils: ErrorUtilsLike = {
    getGlobalHandler: jest.fn(() => handler),
    setGlobalHandler: jest.fn((next) => {
      handler = next;
    }),
  };
  return { errorUtils, original, getHandler: () => handler };
}

function expectNoOriginalData(value: string) {
  expect(value).not.toContain('session-7d214d3f');
  expect(value).not.toContain('Bearer very-secret-token');
  expect(value).not.toContain('access_token=very-secret-token');
  expect(value).not.toContain('fragment-secret');
  expect(value).not.toContain('CustomFailureForJisoo');
}

beforeEach(async () => {
  await AsyncStorage.clear();
  useAppNoticeStore.setState({ notice: null });
});

test('observed error retains only a whitelisted generated bundle frame and safe category', () => {
  const error = new Error(
    'session-7d214d3f\nAuthorization: Bearer very-secret-token',
  );
  error.name = 'CustomFailureForJisoo';
  error.stack = [
    'CustomFailureForJisoo: session-7d214d3f',
    '    at fetchProfile (https://api.example.test/v1/me?access_token=very-secret-token#fragment-secret:11:2)',
    '    at render (index.ios.bundle:41:9)',
  ].join('\n');

  const observed = createSanitizedObservedError(error, 'global-fatal');
  const encoded = `${observed.name}\n${observed.message}\n${observed.stack}`;

  expect(observed.name).toBe('SoulAppObservedError');
  expect(observed.message).toBe('soul-app.global-fatal.error');
  expect(observed.stack).toContain('at <frame> (index.ios.bundle:41:9)');
  expect(observed.stack).not.toContain('api.example.test');
  expectNoOriginalData(encoded);
});

test('observed error retains a Hermes address marker and bundle coordinates without the path', () => {
  const error = new Error('Bearer very-secret-token');
  error.stack = [
    'Error: Bearer very-secret-token',
    '    at render (address at index.ios.bundle:1:1534)',
    '    at launch (file:///private/var/containers/Bundle/Application/secret/main.jsbundle:42:9)',
    '    at rejected (index.ios.bundle?access_token=very-secret-token:7:3)',
    '    at rejected-fragment (main.jsbundle#fragment-secret:8:4)',
  ].join('\n');

  const observed = createSanitizedObservedError(error, 'global-fatal');
  const encoded = `${observed.name}\n${observed.message}\n${observed.stack}`;

  expect(observed.stack).toContain('at <frame> (address at index.ios.bundle:1:1534)');
  expect(observed.stack).toContain('at <frame> (main.jsbundle:42:9)');
  expect(observed.stack).not.toContain('access_token');
  expect(observed.stack).not.toContain('fragment-secret');
  expect(observed.stack).not.toContain('/private/var');
  expectNoOriginalData(encoded);
});

test('observed error keeps a safe HTTP status category without a response body', () => {
  const error = new Error('server response: Bearer very-secret-token');
  error.name = 'ApiHttpError';
  Object.assign(error, {
    status: 409,
    body: '{"sessionId":"session-7d214d3f"}',
  });

  const observed = createSanitizedObservedError(error, 'global-nonfatal');
  const encoded = `${observed.name}\n${observed.message}\n${observed.stack}`;

  expect(observed.message).toBe('soul-app.global-nonfatal.api-http-409');
  expectNoOriginalData(encoded);
});

test.each([
  ['string', 'thrown-string'],
  [{ sessionId: 'session-7d214d3f', title: 'private title' }, 'thrown-object'],
])('observed error does not stringify a non-Error throw: %p', (thrown, category) => {
  const observed = createSanitizedObservedError(thrown, 'session-succession-render');
  const encoded = `${observed.name}\n${observed.message}\n${observed.stack}`;

  expect(observed.message).toBe(`soul-app.session-succession-render.${category}`);
  expectNoOriginalData(encoded);
});

test('captures the RN handler before Observe import and replaces its raw wrapper', async () => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const observeReportError = jest.fn();
  const observeConfigure = jest.fn();
  const appMetricsReportError = jest.fn();
  let rawObserveHandler: jest.Mock | null = null;
  const loadObserve = jest.fn(() => {
    expect(getHandler()).toBe(original);
    rawObserveHandler = jest.fn((error, isFatal) => original(error, isFatal));
    errorUtils.setGlobalHandler(rawObserveHandler);
    return {
      Observe: {
        configure: observeConfigure,
        reportError: observeReportError,
      },
      AppMetrics: {
        reportError: appMetricsReportError,
      },
    };
  });

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve,
      log: jest.fn(),
    }),
  ).toBe(true);

  const error = new Error('session-7d214d3f?access_token=very-secret-token');
  getHandler()(error, false);
  getHandler()(error, true);

  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
    expect(raw ? JSON.parse(raw).pending.length : 0).toBe(1);
  });

  expect(loadObserve).toHaveBeenCalledTimes(1);
  expect(observeConfigure).toHaveBeenCalledWith({
    integrations: {
      'expo-router': false,
      'react-navigation': false,
    },
  });
  expect(rawObserveHandler).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledWith(error, false);
  expect(observeReportError).not.toHaveBeenCalled();
  expect(appMetricsReportError).toHaveBeenCalledTimes(2);
  expect(appMetricsReportError).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      source: 'global',
      type: 'SoulAppObservedError',
      message: 'soul-app.global-nonfatal.error',
      isFatal: false,
    }),
  );
  expect(appMetricsReportError).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      source: 'global',
      type: 'SoulAppObservedError',
      message: 'soul-app.global-fatal.error',
      isFatal: true,
    }),
  );
  expectNoOriginalData(
    appMetricsReportError.mock.calls
      .map(([reported]) => JSON.stringify(reported))
      .join('\n'),
  );
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '앱 오류를 복구했습니다.',
  });
});

test('requests a startup flush only after the sanitized bridge replaces the raw Observe handler', async () => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const sequence: string[] = [];
  const observeConfigure = jest.fn(() => sequence.push('configure'));
  const rawObserveHandler = jest.fn();
  const dispatchEvents = jest.fn(() => {
    sequence.push('dispatch');
    expect(getHandler()).not.toBe(rawObserveHandler);
    expect(getHandler()).not.toBe(original);
    return Promise.resolve();
  });

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve: () => {
        errorUtils.setGlobalHandler(rawObserveHandler);
        return {
          Observe: {
            configure: observeConfigure,
            reportError: jest.fn(),
            dispatchEvents,
          },
          AppMetrics: { reportError: jest.fn() },
        };
      },
      log: jest.fn(),
    }),
  ).toBe(true);

  await waitFor(() => expect(dispatchEvents).toHaveBeenCalledTimes(1));
  expect(sequence).toEqual(['configure', 'dispatch']);
});

test('puts diagnostic chunks in a fixed Observe attribute visible to the pinned CLI', async () => {
  const { errorUtils } = createErrorUtils();
  const rawObserveHandler = jest.fn();
  const logEvent = jest.fn();
  const dispatchEvents = jest.fn(async () => undefined);
  const observe = {
    configure: jest.fn(),
    reportError: jest.fn(),
    logEvent,
    dispatchEvents,
  };

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve: () => {
        errorUtils.setGlobalHandler(rawObserveHandler);
        return {
          Observe: observe,
          AppMetrics: { reportError: jest.fn() },
        };
      },
      log: jest.fn(),
    }),
  ).toBe(true);
  await waitFor(() => expect(dispatchEvents).toHaveBeenCalledTimes(1));

  const payload = '{"report_id":"00000000-0000-4000-8000-000000000001","chunk_index":1}';
  expect(logEasObserveEvent('soul-app.diagnostics.chunk', payload)).toBe(true);
  expect(logEvent).toHaveBeenCalledWith('soul-app.diagnostics.chunk', {
    attributes: { soul_app_diagnostics_payload: payload },
  });
});

test.each([
  ['synchronously throws', () => { throw new Error('network failure with secret-like detail'); }],
  ['rejects its promise', () => Promise.reject(new Error('network failure with secret-like detail'))],
])('keeps the sanitized bridge and local recovery when startup dispatch %s', async (_case, dispatch) => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const rawObserveHandler = jest.fn();
  const log = jest.fn();
  const appMetricsReportError = jest.fn();

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve: () => {
        errorUtils.setGlobalHandler(rawObserveHandler);
        return {
          Observe: {
            configure: jest.fn(),
            reportError: jest.fn(),
            dispatchEvents: dispatch,
          },
          AppMetrics: { reportError: appMetricsReportError },
        };
      },
      log,
    }),
  ).toBe(true);

  await waitFor(() => {
    expect(log).toHaveBeenCalledWith(
      '[EasObserve] startup dispatch failed:',
      expect.objectContaining({ message: 'details intentionally omitted' }),
    );
  });
  expect(log.mock.calls.flat().join('\n')).not.toContain('network failure with secret-like detail');

  const error = new Error('session-7d214d3f Bearer very-secret-token');
  getHandler()(error, true);

  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
    expect(raw ? JSON.parse(raw).pending.length : 0).toBe(1);
  });

  expect(rawObserveHandler).not.toHaveBeenCalled();
  expect(original).not.toHaveBeenCalled();
  expect(appMetricsReportError).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'global',
      message: 'soul-app.global-fatal.error',
      isFatal: true,
    }),
  );
  expectNoOriginalData(
    appMetricsReportError.mock.calls.map(([reported]) => JSON.stringify(reported)).join('\n'),
  );
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '앱 오류를 복구했습니다.',
  });
});

test('development leaves the RN handler and Observe module untouched', () => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const loadObserve = jest.fn();

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: true,
      loadObserve,
    }),
  ).toBe(false);

  expect(loadObserve).not.toHaveBeenCalled();
  expect(getHandler()).toBe(original);
});

test('returns to local recovery when the Observe loader installs a raw handler then throws', async () => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const rawObserveHandler = jest.fn();
  const loadObserve = jest.fn(() => {
    errorUtils.setGlobalHandler(rawObserveHandler);
    throw new Error('Observe module failed after ErrorUtils hook installation');
  });

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve,
      log: jest.fn(),
    }),
  ).toBe(false);

  const error = new Error('session-7d214d3f Bearer very-secret-token');
  getHandler()(error, false);
  getHandler()(error, true);

  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
    expect(raw ? JSON.parse(raw).pending.length : 0).toBe(1);
  });

  expect(rawObserveHandler).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledWith(error, false);
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '앱 오류를 복구했습니다.',
  });
});

test.each([
  [
    'the module is malformed',
    () => ({
      Observe: { configure: jest.fn(), reportError: jest.fn() },
    }),
  ],
  [
    'privacy configuration throws',
    () => ({
      Observe: {
        configure: () => {
          throw new Error('configuration failed');
        },
        reportError: jest.fn(),
      },
      AppMetrics: { reportError: jest.fn() },
    }),
  ],
])('returns to local recovery when $s', async (_reason, createObserve) => {
  const { errorUtils, original, getHandler } = createErrorUtils();
  const rawObserveHandler = jest.fn();

  expect(
    installEasObserveCrashReporting({
      errorUtils,
      isDev: false,
      loadObserve: () => {
        errorUtils.setGlobalHandler(rawObserveHandler);
        return createObserve() as never;
      },
      log: jest.fn(),
    }),
  ).toBe(false);

  const error = new Error('session-7d214d3f Bearer very-secret-token');
  getHandler()(error, false);
  getHandler()(error, true);

  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
    expect(raw ? JSON.parse(raw).pending.length : 0).toBe(1);
  });

  expect(rawObserveHandler).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledWith(error, false);
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    title: '앱 오류를 복구했습니다.',
  });
});

test('handled reporting uses the same sanitized registry after installation', () => {
  const { errorUtils } = createErrorUtils();
  const observeReportError = jest.fn();
  const observeConfigure = jest.fn();
  const appMetricsReportError = jest.fn();
  installEasObserveCrashReporting({
    errorUtils,
    isDev: false,
    loadObserve: () => ({
      Observe: {
        configure: observeConfigure,
        reportError: observeReportError,
      },
      AppMetrics: {
        reportError: appMetricsReportError,
      },
    }),
  });

  reportSanitizedEasObserveError(
    { sessionId: 'session-7d214d3f', title: 'private title' },
    'glass-surface-role',
  );

  expect(observeReportError).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'SoulAppObservedError',
      message: 'soul-app.glass-surface-role.thrown-object',
    }),
  );
  expect(observeConfigure).toHaveBeenCalledWith({
    integrations: {
      'expo-router': false,
      'react-navigation': false,
    },
  });
  const [reported] = observeReportError.mock.calls.at(-1) ?? [];
  expectNoOriginalData(`${reported.name}\n${reported.message}\n${reported.stack}`);
  expect(appMetricsReportError).not.toHaveBeenCalled();
});
