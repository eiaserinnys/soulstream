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
  expect(screen.getByText('앱과 기기 정보 및 관련 폴더·프로젝트·세션 식별자를 포함한 전체 JSON을 클립보드에 복사합니다.')).toBeTruthy();
  expect(screen.getByText('전체 JSON을 클립보드에 복사했습니다.').props.accessibilityLiveRegion).toBe('polite');
  expect(copied.records[0]).toMatchObject({ app: expect.any(Object), device: expect.any(Object) });
  expect(screen.getByText('복사됨')).toBeTruthy();
});


test('화면과 전체 JSON 복사는 오류의 민감값을 제거하고 관련 오류 식별자는 유지한다', async () => {
  await enqueueGlobalAppFailure(createGlobalAppFailureRecord(
    new Error('Authorization: Bearer secret-example token=secret-token\nHTTP 500 {"token":"secret-json","accessToken":"secret-access"}\nCookie: first=secret-first; second=secret-second\nrequestId=public-request'),
    { occurredAt: new Date('2026-10-04T00:00:00Z') },
  ));
  const screen = render(<SessionDiagnosticsSection/>);
  fireEvent.press(await screen.findByTestId('session-diagnostics-copy-all'));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalled());
  const copied = jest.mocked(Clipboard.setStringAsync).mock.calls[0][0];
  expect(copied).not.toContain('secret-example');
  for (const value of ['secret-token', 'secret-json', 'secret-access', 'secret-first', 'secret-second']) expect(copied).not.toContain(value);
  expect(copied).toContain('public-request');
  expect(JSON.parse(copied).records[0].occurredAt).toBe('2026-10-04T00:00:00.000Z');
  expect(JSON.stringify(screen.toJSON())).not.toContain('secret-example');
});

test('클립보드 실패를 오류 상태와 live 결과로 표시한다', async () => {
  await enqueueGlobalAppFailure(createGlobalAppFailureRecord(new Error('공개 오류')));
  jest.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('OS clipboard failure'));
  const screen = render(<SessionDiagnosticsSection/>);
  fireEvent.press(await screen.findByTestId('session-diagnostics-copy-all'));
  const result = await screen.findByText('클립보드에 복사하지 못했습니다. 다시 시도해 주세요.');
  expect(result.props.accessibilityRole).toBe('alert');
  expect(result.props.accessibilityLiveRegion).toBe('polite');
  expect(screen.getByText('다시 복사')).toBeTruthy();
});
