import AsyncStorage from '@react-native-async-storage/async-storage';
import { waitFor } from '@testing-library/react-native';
import { useAppNoticeStore } from '../../store/appNoticeStore';
import {
  installProductionGlobalErrorHandler,
  type ErrorUtilsLike,
} from '../global-error-handler';
import { SESSION_SUCCESSION_DIAGNOSTICS_KEY } from '../session-succession-diagnostics';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '1.0.0', ios: { buildNumber: '90' } },
    platform: { ios: { buildNumber: '90' } },
  },
}));

function createErrorUtils() {
  const previous = jest.fn();
  let handler: ReturnType<ErrorUtilsLike['getGlobalHandler']> = previous;
  const errorUtils: ErrorUtilsLike = {
    getGlobalHandler: jest.fn(() => handler),
    setGlobalHandler: jest.fn((next) => {
      handler = next;
    }),
  };
  return {
    errorUtils,
    previous,
    getHandler: () => handler,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  useAppNoticeStore.setState({ notice: null });
});

test('development keeps React Native default handling untouched', () => {
  const { errorUtils } = createErrorUtils();

  expect(installProductionGlobalErrorHandler({ errorUtils, isDev: true })).toBe(false);
  expect(errorUtils.getGlobalHandler).not.toHaveBeenCalled();
  expect(errorUtils.setGlobalHandler).not.toHaveBeenCalled();
});

test('production delegates non-fatal errors and installs only once', () => {
  const { errorUtils, previous, getHandler } = createErrorUtils();

  expect(installProductionGlobalErrorHandler({ errorUtils, isDev: false })).toBe(true);
  expect(installProductionGlobalErrorHandler({ errorUtils, isDev: false })).toBe(false);
  getHandler()(new Error('recoverable warning'), false);

  expect(previous).toHaveBeenCalledWith(expect.any(Error), false);
  expect(errorUtils.setGlobalHandler).toHaveBeenCalledTimes(1);
});

test('production fatal is persisted and shown without delegating to RCTFatal', async () => {
  const { errorUtils, previous, getHandler } = createErrorUtils();
  const log = jest.fn();
  installProductionGlobalErrorHandler({ errorUtils, isDev: false, log });

  getHandler()(new Error('render exploded before agent fetch'), true);

  await waitFor(async () => {
    const raw = await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY);
    expect(raw ? JSON.parse(raw).pending.length : 0).toBe(1);
  });
  const outbox = JSON.parse(
    (await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY)) ?? '{}',
  );
  expect(outbox.pending[0]).toMatchObject({
    phase: 'global',
    error: {
      message: 'render exploded before agent fetch',
      stack: expect.any(String),
    },
  });
  expect(previous).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    '[GlobalErrorHandler] fatal JavaScript error isolated:',
    expect.any(Error),
  );
  expect(useAppNoticeStore.getState().notice).toMatchObject({
    tone: 'error',
    title: '앱 오류를 복구했습니다.',
  });
});
