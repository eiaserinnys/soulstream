import type { SessionEvent } from '../../../api/types';

const mockMediaDevices = {
  getUserMedia: jest.fn(),
};
const mockRTCPeerConnection = jest.fn();
const mockRTCSessionDescription = jest.fn((value) => value);

jest.mock('react-native-webrtc', () => ({
  mediaDevices: mockMediaDevices,
  RTCPeerConnection: mockRTCPeerConnection,
  RTCSessionDescription: mockRTCSessionDescription,
}));

import {
  audioLevelFromStatsReport,
  clearActiveRealtimeVoiceController,
  detectVoiceApprovalDecision,
  extractSessionDescriptionSdp,
  findPendingRealtimeApproval,
  getActiveRealtimeVoiceController,
  resolveLocalOfferSdp,
  setActiveRealtimeVoiceController,
  startRealtimeVoiceSession,
  transcriptPayloadFromEvent,
  type RealtimeVoiceController,
} from '../../../services/realtimeVoice';

beforeEach(() => {
  jest.useRealTimers();
  mockMediaDevices.getUserMedia.mockReset();
  mockRTCPeerConnection.mockReset();
  mockRTCSessionDescription.mockClear();
});

describe('detectVoiceApprovalDecision', () => {
  it('detects Korean and English approve phrases', () => {
    expect(detectVoiceApprovalDecision('승인합니다')).toBe('approved');
    expect(detectVoiceApprovalDecision('yes approve it')).toBe('approved');
  });

  it('detects Korean and English reject phrases before approve phrases', () => {
    expect(detectVoiceApprovalDecision('거부해')).toBe('rejected');
    expect(detectVoiceApprovalDecision('no, reject')).toBe('rejected');
  });
});

describe('findPendingRealtimeApproval', () => {
  it('returns latest unresolved realtime approval', () => {
    const events: SessionEvent[] = [
      {
        id: '1',
        type: 'tool_approval_requested',
        data: { approval_id: 'old', realtime: true },
      },
      {
        id: '2',
        type: 'tool_approval_resolved',
        data: { approval_id: 'old', decision: 'approved' },
      },
      {
        id: '3',
        type: 'tool_approval_requested',
        data: { approval_id: 'new', realtime: true, tool_name: 'delete_file' },
      },
    ];

    expect(findPendingRealtimeApproval(events)).toMatchObject({
      approval_id: 'new',
      tool_name: 'delete_file',
    });
  });

  it('ignores non-realtime approvals', () => {
    const events: SessionEvent[] = [
      {
        id: '1',
        type: 'tool_approval_requested',
        data: { approval_id: 'text', realtime: false },
      },
    ];

    expect(findPendingRealtimeApproval(events)).toBeNull();
  });
});

describe('transcriptPayloadFromEvent', () => {
  it('accepts normalized realtime transcript payloads', () => {
    expect(
      transcriptPayloadFromEvent({
        type: 'realtime_transcript',
        role: 'user',
        text: 'hello',
      }),
    ).toEqual({ type: 'realtime_transcript', role: 'user', text: 'hello' });
  });

  it('rejects malformed payloads', () => {
    expect(transcriptPayloadFromEvent({ type: 'realtime_transcript', role: 'bot' })).toBeNull();
  });
});

describe('active realtime voice controller registry', () => {
  it('shares the active controller for tap-based approval forwarding', () => {
    const controller = {
      callId: 'call-1',
      mute: jest.fn(),
      interrupt: jest.fn(),
      sendDataChannelEvent: jest.fn(),
      subscribeAudioLevel: jest.fn(() => jest.fn()),
      close: jest.fn(),
    } satisfies RealtimeVoiceController;

    setActiveRealtimeVoiceController('sess-1', controller);
    expect(getActiveRealtimeVoiceController('sess-1')).toBe(controller);

    clearActiveRealtimeVoiceController('sess-1', controller);
    expect(getActiveRealtimeVoiceController('sess-1')).toBeNull();
  });

  it('does not clear a newer controller with a stale cleanup callback', () => {
    const stale = {
      callId: 'old',
      mute: jest.fn(),
      interrupt: jest.fn(),
      sendDataChannelEvent: jest.fn(),
      subscribeAudioLevel: jest.fn(() => jest.fn()),
      close: jest.fn(),
    } satisfies RealtimeVoiceController;
    const current = {
      ...stale,
      callId: 'new',
    } satisfies RealtimeVoiceController;

    setActiveRealtimeVoiceController('sess-1', stale);
    setActiveRealtimeVoiceController('sess-1', current);
    clearActiveRealtimeVoiceController('sess-1', stale);

    expect(getActiveRealtimeVoiceController('sess-1')).toBe(current);
    clearActiveRealtimeVoiceController('sess-1', current);
  });
});

describe('realtime WebRTC offer and local audio level', () => {
  function makePeerConnection(overrides: Record<string, unknown> = {}) {
    const dataChannel = {
      readyState: 'open',
      send: jest.fn(),
      close: jest.fn(),
    };
    let pc: any;
    pc = {
      localDescription: null as unknown,
      addTrack: jest.fn(),
      close: jest.fn(),
      createDataChannel: jest.fn(() => dataChannel),
      createOffer: jest.fn(async () => ({ type: 'offer' })),
      setLocalDescription: jest.fn(async () => {
        pc.localDescription = { type: 'offer', _sdp: 'local-offer-sdp' };
      }),
      setRemoteDescription: jest.fn(),
      getStats: jest.fn(async () =>
        new Map([['audio', { type: 'media-source', kind: 'audio', audioLevel: 0.42 }]]),
      ),
      ...overrides,
    };
    mockRTCPeerConnection.mockImplementation(() => pc);
    return { pc, dataChannel };
  }

  function makeStream() {
    const track = { enabled: true, stop: jest.fn() };
    return {
      getTracks: jest.fn(() => [track]),
      getAudioTracks: jest.fn(() => [track]),
      track,
    };
  }

  it('extracts SDP from standard, React Native private, JSON, and local descriptions', () => {
    expect(extractSessionDescriptionSdp({ sdp: 'standard-offer' })).toBe('standard-offer');
    expect(extractSessionDescriptionSdp({ _sdp: 'rn-private-offer' })).toBe('rn-private-offer');
    expect(
      extractSessionDescriptionSdp({
        toJSON: () => ({ sdp: 'json-offer' }),
      }),
    ).toBe('json-offer');
    expect(
      extractSessionDescriptionSdp({ type: 'offer' }, { _sdp: 'local-description-offer' }),
    ).toBe('local-description-offer');
    expect(extractSessionDescriptionSdp({ sdp: '   ' })).toBeNull();
  });

  it('uses direct offer SDP and passes RN WebRTC 124 audio offer options', async () => {
    const stream = makeStream();
    mockMediaDevices.getUserMedia.mockResolvedValue(stream);
    const { pc } = makePeerConnection({
      createOffer: jest.fn(async () => ({ type: 'offer', sdp: 'direct-offer-sdp' })),
      setLocalDescription: jest.fn(async () => undefined),
    });
    const api = {
      createRealtimeCall: jest.fn(async () => ({
        status: 'ok',
        callId: 'call_1',
        answerSdp: 'answer-sdp',
      })),
      sendRealtimeEvent: jest.fn(async () => ({ status: 'ok' })),
    };

    const controller = await startRealtimeVoiceSession({
      api: api as never,
      sessionId: 'sess-1',
      voice: 'alloy',
    });

    expect(pc.createOffer).toHaveBeenCalledWith({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
      voiceActivityDetection: true,
    });
    expect(api.createRealtimeCall).toHaveBeenCalledWith('sess-1', {
      offerSdp: 'direct-offer-sdp',
      voice: 'alloy',
    });
    controller.close();
  });

  it('posts a non-empty offerSdp from pc.localDescription when createOffer.sdp is absent', async () => {
    const stream = makeStream();
    mockMediaDevices.getUserMedia.mockResolvedValue(stream);
    const { pc } = makePeerConnection();
    const api = {
      createRealtimeCall: jest.fn(async () => ({
        status: 'ok',
        callId: 'call_1',
        answerSdp: 'answer-sdp',
      })),
      sendRealtimeEvent: jest.fn(async () => ({ status: 'ok' })),
    };

    const controller = await startRealtimeVoiceSession({
      api: api as never,
      sessionId: 'sess-1',
      voice: 'alloy',
    });

    expect(pc.createOffer).toHaveBeenCalledWith({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
      voiceActivityDetection: true,
    });
    expect(api.createRealtimeCall).toHaveBeenCalledWith('sess-1', {
      offerSdp: 'local-offer-sdp',
      voice: 'alloy',
    });
    controller.close();
  });

  it('waits for microtask-delayed pc.localDescription.sdp after setLocalDescription', async () => {
    const pc = {
      localDescription: null as unknown,
    };
    Promise.resolve().then(() => {
      pc.localDescription = { type: 'offer', sdp: 'delayed-local-offer-sdp' };
    });

    await expect(resolveLocalOfferSdp({ type: 'offer' }, pc)).resolves.toBe(
      'delayed-local-offer-sdp',
    );
  });

  it('fails locally with SDP candidate diagnostics before posting realtime call', async () => {
    const stream = makeStream();
    mockMediaDevices.getUserMedia.mockResolvedValue(stream);
    makePeerConnection({
      createOffer: jest.fn(async () => ({
        type: 'offer',
        toJSON: () => ({ type: 'offer' }),
      })),
      setLocalDescription: jest.fn(async () => undefined),
    });
    const api = {
      createRealtimeCall: jest.fn(async () => ({
        status: 'ok',
        callId: 'call_1',
        answerSdp: 'answer-sdp',
      })),
      sendRealtimeEvent: jest.fn(async () => ({ status: 'ok' })),
    };

    await expect(
      startRealtimeVoiceSession({
        api: api as never,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(
      'SDP 추출 실패: offer.sdp=undefined, offer._sdp=undefined, offer.toJSON()={"type":"offer"}, pc.localDescription=null',
    );
    expect(api.createRealtimeCall).not.toHaveBeenCalled();
  });

  it('extracts audio level from WebRTC getStats reports', () => {
    expect(
      audioLevelFromStatsReport(
        new Map([['audio', { type: 'media-source', kind: 'audio', audioLevel: 0.7 }]]),
      ),
    ).toBeCloseTo(0.7);
    expect(
      audioLevelFromStatsReport(
        new Map([['audio', { type: 'media-source', kind: 'audio', audioLevel: 2 }]]),
      ),
    ).toBe(1);
    expect(audioLevelFromStatsReport(new Map([['video', { kind: 'video', audioLevel: 0.7 }]]))).toBe(
      0,
    );
  });

  it('emits polled audio levels through the realtime controller subscription', async () => {
    jest.useFakeTimers();
    const stream = makeStream();
    mockMediaDevices.getUserMedia.mockResolvedValue(stream);
    makePeerConnection();
    const api = {
      createRealtimeCall: jest.fn(async () => ({
        status: 'ok',
        callId: 'call_1',
        answerSdp: 'answer-sdp',
      })),
      sendRealtimeEvent: jest.fn(async () => ({ status: 'ok' })),
    };

    const controller = await startRealtimeVoiceSession({
      api: api as never,
      sessionId: 'sess-1',
    });
    const listener = jest.fn();
    controller.subscribeAudioLevel(listener);

    await jest.advanceTimersByTimeAsync(180);

    expect(listener).toHaveBeenCalledWith(0.42);
    controller.close();
    jest.useRealTimers();
  });
});
