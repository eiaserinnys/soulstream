import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  createGlobalAppFailureRecord,
  enqueueGlobalAppFailure,
} from '../../../lib/session-succession-diagnostics';
import { SessionDiagnosticsSection } from '../SessionDiagnosticsSection';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('persisted fatal message, stack, and component stack are visible for screenshots', async () => {
  const record = createGlobalAppFailureRecord(
    new Error('first iPad JavaScript failure'),
    {
      componentStack: '\n    at SessionSuccessionSheetContent',
      occurredAt: new Date('2026-07-25T06:34:40.890Z'),
    },
  );
  await enqueueGlobalAppFailure(record);

  const screen = render(<SessionDiagnosticsSection />);

  expect(await screen.findByText('앱 진단 기록')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('first iPad JavaScript failure')).toBeTruthy());
  expect(screen.queryByTestId('session-diagnostic-stack')).toBeNull();
  fireEvent.press(screen.getByTestId('session-diagnostic-expand-0'));
  expect(screen.getByText(/SessionSuccessionSheetContent/)).toBeTruthy();
  expect(screen.getByText(/global/)).toBeTruthy();
  expect(screen.getByTestId('session-diagnostic-stack').props.selectable).toBe(true);
});

test('전체 진단 기록을 한 번에 복사하고 성공 상태를 표시한다', async () => {
  await enqueueGlobalAppFailure(createGlobalAppFailureRecord(
    new Error('붙여넣기로 전달할 오류'),
    { occurredAt: new Date('2026-07-25T12:13:14.176Z') },
  ));
  const screen = render(<SessionDiagnosticsSection />);

  const copyButton = await screen.findByTestId('session-diagnostics-copy-all');
  fireEvent.press(copyButton);

  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1));
  const copied = JSON.parse(
    (Clipboard.setStringAsync as jest.Mock).mock.calls[0][0],
  );
  expect(copied).toMatchObject({
    schemaVersion: 1,
    records: [
      expect.objectContaining({
        error: expect.objectContaining({ message: '붙여넣기로 전달할 오류' }),
      }),
    ],
  });
  expect(screen.getByText('복사됨')).toBeTruthy();
});


test('화면과 전체 JSON 복사는 오류의 민감값을 제거하고 관련 오류 식별자는 유지한다', async () => {
  await enqueueGlobalAppFailure(createGlobalAppFailureRecord(
    new Error('Authorization: Bearer secret-example token=secret-token'),
    { occurredAt: new Date('2026-10-04T00:00:00Z') },
  ));
  const screen = render(<SessionDiagnosticsSection/>);
  fireEvent.press(await screen.findByTestId('session-diagnostics-copy-all'));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalled());
  const copied = jest.mocked(Clipboard.setStringAsync).mock.calls[0][0];
  expect(copied).not.toContain('secret-example');
  expect(copied).not.toContain('secret-token');
  expect(JSON.parse(copied).records[0].occurredAt).toBe('2026-10-04T00:00:00.000Z');
  expect(JSON.stringify(screen.toJSON())).not.toContain('secret-example');
});
