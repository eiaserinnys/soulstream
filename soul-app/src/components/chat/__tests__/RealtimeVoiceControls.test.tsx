import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

jest.mock('../../../services/realtimeVoice', () => ({
  approvalIdFromPayload: jest.fn(),
  clearActiveRealtimeVoiceController: jest.fn(),
  detectVoiceApprovalDecision: jest.fn(),
  findPendingRealtimeApproval: jest.fn(() => null),
  setActiveRealtimeVoiceController: jest.fn(),
  startRealtimeVoiceSession: jest.fn(),
}));

import {
  clearActiveRealtimeVoiceController,
  setActiveRealtimeVoiceController,
  startRealtimeVoiceSession,
} from '../../../services/realtimeVoice';
import { formatRealtimeStartError, RealtimeVoiceControls } from '../RealtimeVoiceControls';

const api = {
  resolveRealtimeToolApproval: jest.fn(),
};

function voiceController() {
  const unsubscribe = jest.fn();
  return {
    controller: {
      callId: 'call_1',
      mute: jest.fn(),
      interrupt: jest.fn(),
      sendDataChannelEvent: jest.fn(),
      subscribeAudioLevel: jest.fn(() => unsubscribe),
      close: jest.fn(),
    },
    unsubscribe,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  (startRealtimeVoiceSession as jest.Mock).mockReset();
  (setActiveRealtimeVoiceController as jest.Mock).mockClear();
  (clearActiveRealtimeVoiceController as jest.Mock).mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RealtimeVoiceControls', () => {
  it.each([
    ['phone', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
    ['iPad', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
  ] as const)('%s compact control은 visual40과 touch frame%i를 분리한다', (
    _label,
    dimensions,
    hitTarget,
  ) => {
    mockDimensions = dimensions;
    const screen = render(
      <RealtimeVoiceControls api={api as never} sessionId="sess-1" backend="codex" events={[]} compact />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('realtime-voice-toggle').props.style))
      .toMatchObject({ minWidth: hitTarget, minHeight: hitTarget });
    expect(StyleSheet.flatten(screen.getByTestId('realtime-voice-toggle-visual').props.style))
      .toMatchObject({ width: 40, height: 40 });
  });

  it('shows realtime start 422 detail instead of silently swallowing it', async () => {
    (startRealtimeVoiceSession as jest.Mock).mockRejectedValueOnce(
      new Error(
        '[createRealtimeCall] HTTP 422 Unprocessable Entity — {"detail":[{"type":"missing","loc":["body","offerSdp"],"msg":"Field required","input":{"voice":"alloy"}}]}',
      ),
    );
    const { getByTestId } = render(
      <RealtimeVoiceControls api={api as never} sessionId="sess-1" backend="codex" events={[]} compact />,
    );

    fireEvent.press(getByTestId('realtime-voice-toggle'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '음성 세션 시작 실패',
        expect.stringContaining('음성 세션 시작 실패 (server 422):'),
      );
    });
    expect((Alert.alert as jest.Mock).mock.calls[0][1]).toContain(
      '"loc":["body","offerSdp"]',
    );
  });

  it('renders and clears the inline waveform for an active compact voice session', async () => {
    const { controller } = voiceController();
    (startRealtimeVoiceSession as jest.Mock).mockResolvedValueOnce(controller);
    const { getByTestId, queryByTestId } = render(
      <RealtimeVoiceControls api={api as never} sessionId="sess-1" backend="codex" events={[]} compact />,
    );

    fireEvent.press(getByTestId('realtime-voice-toggle'));

    await waitFor(() => {
      expect(getByTestId('realtime-voice-waveform')).toBeTruthy();
    });

    fireEvent.press(getByTestId('realtime-voice-toggle'));

    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(queryByTestId('realtime-voice-waveform')).toBeNull();
  });

  it('active voice를 offline 전환 즉시 단일 cleanup으로 닫고 구독·global controller를 해제한다', async () => {
    const { controller, unsubscribe } = voiceController();
    (startRealtimeVoiceSession as jest.Mock).mockResolvedValueOnce(controller);
    const { getByTestId, queryByTestId, rerender } = render(
      <RealtimeVoiceControls
        api={api as never}
        sessionId="sess-1"
        backend="codex"
        events={[]}
        compact
        disabled={false}
      />,
    );

    fireEvent.press(getByTestId('realtime-voice-toggle'));
    await waitFor(() => expect(setActiveRealtimeVoiceController).toHaveBeenCalledWith('sess-1', controller));

    rerender(
      <RealtimeVoiceControls
        api={api as never}
        sessionId="sess-1"
        backend="codex"
        events={[]}
        compact
        disabled
      />,
    );

    await waitFor(() => expect(controller.close).toHaveBeenCalledTimes(1));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearActiveRealtimeVoiceController).toHaveBeenCalledWith('sess-1', controller);
    expect(queryByTestId('realtime-voice-waveform')).toBeNull();
  });

  it('connecting 중 offline이면 late controller를 닫고 reconnect 뒤 새 start만 등록한다', async () => {
    const late = deferred<ReturnType<typeof voiceController>['controller']>();
    const stale = voiceController();
    const fresh = voiceController();
    (startRealtimeVoiceSession as jest.Mock)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(fresh.controller);
    const { getByTestId, rerender } = render(
      <RealtimeVoiceControls
        api={api as never}
        sessionId="sess-1"
        backend="codex"
        events={[]}
        compact
        disabled={false}
      />,
    );

    fireEvent.press(getByTestId('realtime-voice-toggle'));
    await waitFor(() => expect(startRealtimeVoiceSession).toHaveBeenCalledTimes(1));
    rerender(
      <RealtimeVoiceControls
        api={api as never}
        sessionId="sess-1"
        backend="codex"
        events={[]}
        compact
        disabled
      />,
    );
    await act(async () => late.resolve(stale.controller));

    expect(stale.controller.close).toHaveBeenCalledTimes(1);
    expect(stale.controller.subscribeAudioLevel).not.toHaveBeenCalled();
    expect(setActiveRealtimeVoiceController).not.toHaveBeenCalledWith('sess-1', stale.controller);

    rerender(
      <RealtimeVoiceControls
        api={api as never}
        sessionId="sess-1"
        backend="codex"
        events={[]}
        compact
        disabled={false}
      />,
    );
    fireEvent.press(getByTestId('realtime-voice-toggle'));

    await waitFor(() => {
      expect(startRealtimeVoiceSession).toHaveBeenCalledTimes(2);
      expect(setActiveRealtimeVoiceController).toHaveBeenCalledWith('sess-1', fresh.controller);
    });
  });

  it('prefixes client-side SDP extraction failures separately from server errors', () => {
    expect(
      formatRealtimeStartError(
        new Error('SDP 추출 실패: offer.sdp=undefined, pc.localDescription=null'),
      ),
    ).toContain('음성 세션 시작 실패 (client): SDP 추출 실패');
    expect(
      formatRealtimeStartError(
        new Error('[createRealtimeCall] HTTP 422 Unprocessable Entity — {"detail":"bad"}'),
      ),
    ).toBe('음성 세션 시작 실패 (server 422): bad');
  });

  it('disables realtime voice for non-codex sessions', () => {
    const { getByTestId } = render(
      <RealtimeVoiceControls api={api as never} sessionId="sess-1" backend="claude" events={[]} compact />,
    );

    fireEvent.press(getByTestId('realtime-voice-toggle'));

    expect(startRealtimeVoiceSession).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
