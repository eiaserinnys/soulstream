import type { ApiClient } from '../api/client';
import type {
  RealtimeTranscriptPayload,
  SessionEvent,
  ToolApprovalPayload,
  ToolApprovalResolvedPayload,
} from '../api/types';

export type VoiceApprovalDecision = 'approved' | 'rejected';
export type AudioLevelListener = (level: number) => void;

declare const require: (moduleName: string) => unknown;

const REALTIME_AUDIO_OFFER_OPTIONS = {
  offerToReceiveAudio: true,
  offerToReceiveVideo: false,
  voiceActivityDetection: true,
};
const LOCAL_DESCRIPTION_POLL_ATTEMPTS = 3;

export interface RealtimeVoiceController {
  callId: string;
  mute(muted: boolean): void;
  interrupt(): void;
  sendDataChannelEvent(event: Record<string, unknown>): void;
  subscribeAudioLevel(listener: AudioLevelListener): () => void;
  close(): void;
}

const activeControllers = new Map<string, RealtimeVoiceController>();

export function setActiveRealtimeVoiceController(
  sessionId: string,
  controller: RealtimeVoiceController,
) {
  activeControllers.set(sessionId, controller);
}

export function getActiveRealtimeVoiceController(
  sessionId: string,
): RealtimeVoiceController | null {
  return activeControllers.get(sessionId) ?? null;
}

export function clearActiveRealtimeVoiceController(
  sessionId: string,
  controller?: RealtimeVoiceController | null,
) {
  if (controller && activeControllers.get(sessionId) !== controller) return;
  activeControllers.delete(sessionId);
}

export interface StartRealtimeVoiceParams {
  api: ApiClient;
  sessionId: string;
  model?: string;
  voice?: string;
  instructions?: string;
  onStatus?: (status: string) => void;
  onRealtimeEvent?: (event: Record<string, unknown>) => void;
}

export async function startRealtimeVoiceSession({
  api,
  sessionId,
  model,
  voice,
  instructions,
  onStatus,
  onRealtimeEvent,
}: StartRealtimeVoiceParams): Promise<RealtimeVoiceController> {
  onStatus?.('requesting_microphone');
  const {
    mediaDevices,
    RTCPeerConnection,
    RTCSessionDescription,
  } = await loadReactNativeWebRTC();

  const localStream = await mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  onStatus?.('connecting');

  const pc = new RTCPeerConnection({}) as any;
  const dataChannel = pc.createDataChannel('oai-events');
  const audioMonitor = createAudioLevelMonitor(pc);
  let callId = '';
  let closed = false;

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  dataChannel.onopen = () => {
    onStatus?.('connected');
  };
  dataChannel.onmessage = (message: { data?: unknown }) => {
    const parsed = parseDataChannelMessage(message.data);
    if (!parsed) return;
    onRealtimeEvent?.(parsed);
    void api.sendRealtimeEvent(sessionId, parsed, callId).catch(() => undefined);
  };
  dataChannel.onerror = () => {
    onStatus?.('error');
  };
  dataChannel.onclose = () => {
    onStatus?.('closed');
  };

  try {
    const offer = await pc.createOffer(REALTIME_AUDIO_OFFER_OPTIONS);
    await pc.setLocalDescription(offer);
    const offerSdp = await resolveLocalOfferSdp(offer, pc);
    const answer = await api.createRealtimeCall(sessionId, {
      offerSdp,
      ...(model ? { model } : {}),
      ...(voice ? { voice } : {}),
      ...(instructions ? { instructions } : {}),
    });
    callId = answer.callId;
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: answer.answerSdp }),
    );
  } catch (err) {
    closeLocalResources();
    throw err;
  }

  function closeLocalResources() {
    if (closed) return;
    closed = true;
    audioMonitor.stop();
    dataChannel.close?.();
    pc.close?.();
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }

  return {
    get callId() {
      return callId;
    },
    mute(muted: boolean) {
      for (const track of localStream.getAudioTracks()) {
        track.enabled = !muted;
      }
      void api.sendRealtimeEvent(
        sessionId,
        { type: 'realtime_status', status: muted ? 'muted' : 'unmuted' },
        callId,
      ).catch(() => undefined);
    },
    interrupt() {
      sendJson(dataChannel, { type: 'response.cancel' });
      void api.sendRealtimeEvent(
        sessionId,
        { type: 'realtime_status', status: 'interrupted' },
        callId,
      ).catch(() => undefined);
    },
    sendDataChannelEvent(event: Record<string, unknown>) {
      sendJson(dataChannel, event);
    },
    subscribeAudioLevel(listener: AudioLevelListener) {
      return audioMonitor.subscribe(listener);
    },
    close() {
      sendJson(dataChannel, { type: 'response.cancel' });
      closeLocalResources();
      void api.sendRealtimeEvent(
        sessionId,
        { type: 'realtime_status', status: 'closed' },
        callId,
      ).catch(() => undefined);
    },
  };
}

export async function resolveLocalOfferSdp(
  offer: unknown,
  pc: { localDescription?: unknown },
): Promise<string> {
  const directOfferSdp = extractSessionDescriptionSdp(offer);
  if (directOfferSdp) return directOfferSdp;

  for (let attempt = 0; attempt < LOCAL_DESCRIPTION_POLL_ATTEMPTS; attempt += 1) {
    const localDescriptionSdp = extractSessionDescriptionSdp(pc.localDescription);
    if (localDescriptionSdp) return localDescriptionSdp;
    await Promise.resolve();
  }

  const finalLocalDescriptionSdp = extractSessionDescriptionSdp(pc.localDescription);
  if (finalLocalDescriptionSdp) return finalLocalDescriptionSdp;

  throw new Error(
    `SDP 추출 실패: ${describeSdpExtractionCandidates(offer, pc.localDescription)}`,
  );
}

export function extractSessionDescriptionSdp(...descriptions: unknown[]): string | null {
  for (const description of descriptions) {
    const direct = readSdpCandidate(description);
    if (direct) return direct;
    if (!isRecord(description)) continue;
    const toJSON = description.toJSON;
    if (typeof toJSON !== 'function') continue;
    try {
      const serialized = toJSON.call(description);
      const fromJson = readSdpCandidate(serialized);
      if (fromJson) return fromJson;
    } catch {
      // Ignore malformed library serialization and keep checking fallbacks.
    }
  }
  return null;
}

export function audioLevelFromStatsReport(stats: unknown): number {
  let maxLevel = 0;
  forEachStatsReport(stats, (report) => {
    if (!isRecord(report)) return;
    const kind = typeof report.kind === 'string' ? report.kind : undefined;
    if (kind && kind !== 'audio') return;
    const type = typeof report.type === 'string' ? report.type : undefined;
    if (type && type.includes('video')) return;
    const level = typeof report.audioLevel === 'number' ? report.audioLevel : null;
    if (level === null) return;
    maxLevel = Math.max(maxLevel, clampAudioLevel(level));
  });
  return maxLevel;
}

export function findPendingRealtimeApproval(
  events: SessionEvent[],
): ToolApprovalPayload | null {
  const resolved = new Set(
    events
      .filter((event) => event.type === 'tool_approval_resolved')
      .map((event) => approvalIdFromResolved(event.data as ToolApprovalResolvedPayload))
      .filter(Boolean),
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'tool_approval_requested') continue;
    const payload = event.data as ToolApprovalPayload;
    if (!payload.realtime) continue;
    const approvalId = approvalIdFromPayload(payload);
    if (!approvalId || resolved.has(approvalId)) continue;
    return payload;
  }
  return null;
}

export function approvalIdFromPayload(payload: ToolApprovalPayload): string {
  return payload.approval_id || payload.approvalId || '';
}

export function approvalIdFromResolved(payload: ToolApprovalResolvedPayload): string {
  return payload.approval_id || payload.approvalId || '';
}

export function detectVoiceApprovalDecision(
  text: string,
): VoiceApprovalDecision | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  const rejectWords = ['거부', '취소', '중단', '안 돼', '안돼', 'reject', 'rejected', 'no'];
  if (rejectWords.some((word) => normalized.includes(word))) {
    return 'rejected';
  }
  const approveWords = ['승인', '허용', '좋아', '진행', 'approve', 'approved', 'yes', 'ok'];
  if (approveWords.some((word) => normalized.includes(word))) {
    return 'approved';
  }
  return null;
}

export function transcriptPayloadFromEvent(
  event: Record<string, unknown>,
): RealtimeTranscriptPayload | null {
  if (event.type !== 'realtime_transcript') return null;
  if (event.role !== 'user' && event.role !== 'assistant') return null;
  if (typeof event.text !== 'string') return null;
  return event as unknown as RealtimeTranscriptPayload;
}

function parseDataChannelMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(data) ? data : null;
}

function sendJson(channel: { readyState?: string; send?: (data: string) => void }, event: Record<string, unknown>) {
  if (channel.readyState && channel.readyState !== 'open') return;
  channel.send?.(JSON.stringify(event));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadReactNativeWebRTC(): Promise<{
  mediaDevices: { getUserMedia(constraints: Record<string, unknown>): Promise<any> };
  RTCPeerConnection: new (configuration: Record<string, unknown>) => any;
  RTCSessionDescription: new (description: Record<string, unknown>) => unknown;
}> {
  return Promise.resolve(require('react-native-webrtc') as {
    mediaDevices: { getUserMedia(constraints: Record<string, unknown>): Promise<any> };
    RTCPeerConnection: new (configuration: Record<string, unknown>) => any;
    RTCSessionDescription: new (description: Record<string, unknown>) => unknown;
  });
}

function readSdpCandidate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ['sdp', '_sdp']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function describeSdpExtractionCandidates(offer: unknown, localDescription: unknown): string {
  const offerToJson = readToJsonCandidate(offer);
  const localToJson = readToJsonCandidate(localDescription);
  const candidates = [
    ['offer.sdp', readFieldCandidate(offer, 'sdp')],
    ['offer._sdp', readFieldCandidate(offer, '_sdp')],
    ['offer.toJSON()', offerToJson.value],
    ['pc.localDescription', localDescription],
    ['pc.localDescription.sdp', readFieldCandidate(localDescription, 'sdp')],
    ['pc.localDescription._sdp', readFieldCandidate(localDescription, '_sdp')],
    ['pc.localDescription.toJSON()', localToJson.value],
  ];
  return candidates
    .map(([label, value]) => `${label}=${formatDiagnosticValue(value)}`)
    .join(', ');
}

function readFieldCandidate(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readToJsonCandidate(value: unknown): { value: unknown } {
  if (!isRecord(value) || typeof value.toJSON !== 'function') {
    return { value: undefined };
  }
  try {
    return { value: value.toJSON.call(value) };
  } catch (err) {
    return {
      value: `throws ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatDiagnosticValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!value.trim()) return 'empty string';
    return `string(${value.length} chars)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (isRecord(value)) {
    const json = safeDiagnosticJson(value);
    return json.length > 160 ? `${json.slice(0, 157)}...` : json;
  }
  return String(value);
}

function safeDiagnosticJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return `object(keys=${Object.keys(value).join('|')})`;
  }
}

function createAudioLevelMonitor(pc: { getStats?: () => Promise<unknown> }) {
  const listeners = new Set<AudioLevelListener>();
  let stopped = false;
  const timer = setInterval(() => {
    void pollAudioLevel();
  }, 160);

  async function pollAudioLevel() {
    if (stopped || typeof pc.getStats !== 'function') return;
    try {
      const stats = await pc.getStats();
      const level = audioLevelFromStatsReport(stats);
      for (const listener of listeners) {
        listener(level);
      }
    } catch {
      // Realtime audio level is auxiliary UI; failure must not close the call.
    }
  }

  void pollAudioLevel();

  return {
    subscribe(listener: AudioLevelListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}

function forEachStatsReport(stats: unknown, visit: (report: unknown) => void) {
  if (stats && typeof (stats as { forEach?: unknown }).forEach === 'function') {
    (stats as { forEach: (callback: (value: unknown) => void) => void }).forEach(visit);
    return;
  }
  if (Array.isArray(stats)) {
    stats.forEach(visit);
    return;
  }
  if (isRecord(stats)) {
    Object.values(stats).forEach(visit);
  }
}

function clampAudioLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}
