import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { ApiClient } from '../../api/client';
import type { RealtimeTranscriptPayload, SessionEvent } from '../../api/types';
import {
  approvalIdFromPayload,
  clearActiveRealtimeVoiceController,
  detectVoiceApprovalDecision,
  findPendingRealtimeApproval,
  setActiveRealtimeVoiceController,
  startRealtimeVoiceSession,
  type RealtimeVoiceController,
} from '../../services/realtimeVoice';
import { useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';

interface Props {
  api: ApiClient | null;
  sessionId: string | undefined;
  backend?: string | null;
  events: SessionEvent[];
  disabled?: boolean;
  compact?: boolean;
}

export function RealtimeVoiceControls({
  api,
  sessionId,
  backend,
  events,
  disabled,
  compact = false,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const controllerRef = useRef<RealtimeVoiceController | null>(null);
  const controllerSessionIdRef = useRef<string | null>(null);
  const audioLevelUnsubscribeRef = useRef<(() => void) | null>(null);
  const startGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const disabledRef = useRef(Boolean(disabled));
  const sessionIdRef = useRef(sessionId);
  disabledRef.current = Boolean(disabled);
  sessionIdRef.current = sessionId;
  const processedVoiceApprovalIdsRef = useRef(new Set<string>());
  const [status, setStatus] = useState<'idle' | 'requesting_microphone' | 'connecting' | 'connected' | 'muted' | 'error' | 'closed'>('idle');
  const [muted, setMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const pendingApproval = useMemo(
    () => findPendingRealtimeApproval(events),
    [events],
  );

  useEffect(() => {
    if (disabled || !api || !sessionId || !pendingApproval || !controllerRef.current) return;
    const approvalId = approvalIdFromPayload(pendingApproval);
    if (!approvalId) return;
    const latestUserTranscript = [...events]
      .reverse()
      .find((event) => {
        if (event.type !== 'realtime_transcript') return false;
        if (processedVoiceApprovalIdsRef.current.has(event.id)) return false;
        const payload = event.data as unknown as RealtimeTranscriptPayload;
        return payload.role === 'user' && payload.final !== false && typeof payload.text === 'string';
      });
    if (!latestUserTranscript) return;
    const transcript = latestUserTranscript.data as unknown as RealtimeTranscriptPayload;
    const decision = detectVoiceApprovalDecision(transcript.text);
    if (!decision) return;
    processedVoiceApprovalIdsRef.current.add(latestUserTranscript.id);
    void api
      .resolveRealtimeToolApproval(sessionId, approvalId, {
        decision,
        source: 'voice',
        callId: pendingApproval.call_id || pendingApproval.callId,
      })
      .then((result) => {
        if (result.dataChannelEvent && controllerRef.current) {
          controllerRef.current.sendDataChannelEvent(result.dataChannelEvent);
        }
      })
      .catch(() => undefined);
  }, [api, disabled, events, pendingApproval, sessionId]);

  const closeRealtimeVoice = useCallback((updateState: boolean) => {
    // pending start도 같은 generation으로 취소한다. resolve가 늦게 도착하면 toggleVoice의
    // generation guard가 controller를 즉시 close하고 global controller로 등록하지 않는다.
    startGenerationRef.current += 1;
    audioLevelUnsubscribeRef.current?.();
    audioLevelUnsubscribeRef.current = null;
    const controller = controllerRef.current;
    const ownerSessionId = controllerSessionIdRef.current;
    if (controller && ownerSessionId) {
      clearActiveRealtimeVoiceController(ownerSessionId, controller);
    }
    controller?.close();
    controllerRef.current = null;
    controllerSessionIdRef.current = null;
    if (updateState && mountedRef.current) {
      setAudioLevel(0);
      setMuted(false);
      setStatus('closed');
    }
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    setAudioLevel(0);
    setMuted(false);
    setStatus('idle');
    return () => closeRealtimeVoice(false);
  }, [closeRealtimeVoice, sessionId]);

  useEffect(() => {
    if (disabled) closeRealtimeVoice(true);
  }, [closeRealtimeVoice, disabled]);

  const isActive = !!controllerRef.current;
  const busy = status === 'requesting_microphone' || status === 'connecting';
  const supportsRealtime = backend === 'codex';
  const voiceDisabled = !api || !sessionId || !supportsRealtime || disabled || busy;

  async function toggleVoice() {
    if (!api || !sessionId || !supportsRealtime || disabled || busy) return;
    if (controllerRef.current) {
      closeRealtimeVoice(true);
      return;
    }
    const startGeneration = ++startGenerationRef.current;
    const startSessionId = sessionId;
    const isCurrentStart = () => (
      mountedRef.current
      && startGenerationRef.current === startGeneration
      && !disabledRef.current
      && sessionIdRef.current === startSessionId
    );
    try {
      setAudioLevel(0);
      const controller = await startRealtimeVoiceSession({
        api,
        sessionId: startSessionId,
        voice: 'alloy',
        onStatus: (next) => {
          if (isCurrentStart()) setStatus(next as typeof status);
        },
      });
      if (!isCurrentStart()) {
        controller.close();
        return;
      }
      controllerRef.current = controller;
      controllerSessionIdRef.current = startSessionId;
      audioLevelUnsubscribeRef.current = controller.subscribeAudioLevel((level) => {
        if (isCurrentStart()) setAudioLevel(level);
      });
      setActiveRealtimeVoiceController(startSessionId, controller);
      setStatus('connected');
    } catch (err) {
      if (!isCurrentStart()) return;
      controllerRef.current = null;
      controllerSessionIdRef.current = null;
      audioLevelUnsubscribeRef.current?.();
      audioLevelUnsubscribeRef.current = null;
      setAudioLevel(0);
      Alert.alert('음성 세션 시작 실패', formatRealtimeStartError(err));
      setStatus('error');
    }
  }

  function toggleMute() {
    if (disabledRef.current || !controllerRef.current) return;
    const next = !muted;
    controllerRef.current.mute(next);
    setMuted(next);
    setStatus(next ? 'muted' : 'connected');
  }

  function interrupt() {
    if (disabledRef.current) return;
    controllerRef.current?.interrupt();
  }

  const toggleContent = (
    <>
      {busy ? (
        <ActivityIndicator size="small" color={t.colors.accentText} />
      ) : (
        <Ionicons
          name={isActive ? 'stop' : 'mic'}
          size={t.iconSize.standard}
          color={isActive ? t.colors.accentText : t.colors.textSecondary}
        />
      )}
      {compact && isActive ? (
        <RealtimeVoiceWaveform level={audioLevel} styles={styles} />
      ) : null}
    </>
  );

  if (compact) {
    return (
      <View style={[styles.container, styles.compactContainer]}>
        <CompactTouchTarget
          testID="realtime-voice-toggle"
          surfaceTestID="realtime-voice-toggle-visual"
          accessibilityRole="button"
          accessibilityLabel={
            supportsRealtime
              ? (isActive ? '음성 세션 종료' : '음성 세션 시작')
              : '음성 세션 미지원'
          }
          accessibilityState={{ disabled: voiceDisabled }}
          onPress={toggleVoice}
          disabled={voiceDisabled}
          surfaceStyle={[
            styles.compactIconButton,
            isActive && styles.activeButton,
            voiceDisabled && styles.disabledButton,
          ]}
        >
          {toggleContent}
        </CompactTouchTarget>
      </View>
    );
  }

  const toggleButton = (
    <TouchableOpacity
      testID="realtime-voice-toggle"
      accessibilityLabel={
        supportsRealtime
          ? (isActive ? '음성 세션 종료' : '음성 세션 시작')
          : '음성 세션 미지원'
      }
      onPress={toggleVoice}
      disabled={voiceDisabled}
      style={[
        styles.iconButton,
        isActive && styles.activeButton,
        voiceDisabled && styles.disabledButton,
      ]}
    >
      {toggleContent}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {toggleButton}
      {isActive ? (
        <>
          <TouchableOpacity
            accessibilityLabel={muted ? '음소거 해제' : '음소거'}
            onPress={toggleMute}
            style={styles.iconButton}
          >
            <Ionicons
              name={muted ? 'mic-off' : 'volume-medium'}
              size={t.iconSize.standard}
              color={t.colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="응답 중단"
            onPress={interrupt}
            style={styles.iconButton}
          >
            <Ionicons name="pause" size={t.iconSize.standard} color={t.colors.textSecondary} />
          </TouchableOpacity>
        </>
      ) : null}
      <Text style={styles.statusText} numberOfLines={1}>
        {statusLabel(status)}
      </Text>
    </View>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'requesting_microphone':
      return '권한';
    case 'connecting':
      return '연결';
    case 'connected':
      return '음성';
    case 'muted':
      return '음소거';
    case 'error':
      return '오류';
    case 'closed':
    case 'idle':
    default:
      return '';
  }
}

export function formatRealtimeStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '알 수 없는 오류');
  const status = raw.match(/HTTP\s+(\d+)/)?.[1];
  const detail = extractResponseDetail(raw);
  const source = status ? `server ${status}` : 'client';
  return `음성 세션 시작 실패 (${source}): ${detail}`;
}

function extractResponseDetail(raw: string): string {
  const delimiterIndex = raw.indexOf('—');
  const snippet = delimiterIndex >= 0 ? raw.slice(delimiterIndex + 1).trim() : raw;
  try {
    const parsed = JSON.parse(snippet) as { detail?: unknown };
    if (parsed.detail !== undefined) {
      return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
    }
  } catch {
    // Non-JSON errors are still useful as-is.
  }
  return snippet || raw;
}

function RealtimeVoiceWaveform({
  level,
  styles,
}: {
  level: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View pointerEvents="none" testID="realtime-voice-waveform" style={styles.waveform}>
      {waveformBarHeights(level).map((height, index) => (
        <View
          key={`${index}-${height}`}
          style={[styles.waveformBar, { height }]}
        />
      ))}
    </View>
  );
}

export function waveformBarHeights(level: number): number[] {
  const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return [0.35, 0.65, 1, 0.65, 0.35].map((factor) => 4 + Math.round(clamped * factor * 10));
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      minHeight: t.foundation.hitTarget,
    },
    iconButton: {
      width: t.foundation.hitTarget,
      height: t.foundation.hitTarget,
      borderRadius: t.foundation.hitTarget / 2,
      backgroundColor: t.colors.surface,
      borderWidth: 1,
      borderColor: t.colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    compactContainer: {
      gap: 0,
    },
    compactIconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.colors.surface,
      borderWidth: 1,
      borderColor: t.colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    activeButton: {
      backgroundColor: t.colors.accent,
      borderColor: t.colors.accent,
    },
    disabledButton: {
      opacity: 0.45,
    },
    statusText: {
      width: 42,
      fontSize: t.chatFontSize.meta,
      color: t.colors.textMuted,
    },
    waveform: {
      position: 'absolute',
      left: 9,
      right: 9,
      bottom: 5,
      height: 14,
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
    },
    waveformBar: {
      width: 2,
      borderRadius: 1,
      backgroundColor: t.colors.accentText,
      opacity: 0.9,
    },
  });
}
