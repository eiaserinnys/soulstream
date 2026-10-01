import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { utf8ByteLength } from '../lib/session-diagnostics-core';
import {
  beginDiagnosticOperation,
  endDiagnosticOperation,
  recordSseConnection,
  recordSseMessageBytes,
} from '../lib/session-diagnostics-api';
import type { DiagnosticSource } from '../lib/session-diagnostics-core';
import EventSource, {
  type EventSourceEvent,
  type EventSourceOptions,
} from 'react-native-sse';
import {
  captureAuthScope,
  clearAuthForScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../lib/auth-scope';

interface UseSSEStreamOptions {
  /**
   * 매 connect 시(첫 연결 + 재연결마다) 호출되어 최신 URL을 반환한다.
   *
   * 이전의 `url: string` 단일 입력은 lastEventId/instanceId 변경마다 effect 재발화로
   * SSE가 매번 끊겼다 붙는 비효율을 만들었고, url 모드와 urlBuilder 모드를 함께 두면
   * 정본 둘이 되어 design-principles §3 위배. urlBuilder 단일 패턴으로 통일한다.
   *
   * urlBuilderRef로 보관되어 useEffect deps에 들어가지 않는다 — 무한 재연결 방지.
   * 빈 문자열을 반환하면 connect를 건너뛴다.
   */
  urlBuilder: () => string;
  eventTypes: readonly string[];
  onEvent: (eventType: string, data: unknown, lastEventId: string) => void;
  onError?: (err: unknown) => void;
  // 첫 연결·retry·background 복귀 재연결에서 새 EventSource를 만들기 직전에 호출한다.
  // snapshot 기반 호출자는 stale projection을 즉시 not-ready로 닫는 데 사용한다.
  onConnecting?: () => void;
  // SSE 'open' 이벤트가 발생할 때마다 호출. 첫 연결과 재연결을 모두 포함하므로
  // 호출자는 매 호출에 대해 idempotent해야 한다 (예: catchup 게이트 ref를 true로 리셋).
  // 콜백은 동기·경량·non-throwing이어야 한다 — EventSource 'open' 핸들러에서
  // 직접 호출되므로 throw 시 라이브러리 측 동작이 보장되지 않는다.
  onOpen?: () => void;
  /** background 진입 시 EventSource를 닫기 직전에 호출하는 동기 cleanup 경계. */
  onSuspending?: () => void;
  /** hook 밖의 비동기 consumer commit도 현재 transport를 즉시 실패시킬 수 있는 bridge. */
  consumerFailureRef?: { current: (error: unknown) => void };
  enabled: boolean;
  /**
   * 변경 시 cleanup → connect 재실행을 트리거한다 (deps에 포함).
   *
   * urlBuilder는 ref 우회로 deps 제외이므로, 호출자가 "재연결이 필요한 단위"를
   * 명시적으로 표명해야 한다. 예: ChatBody는 sessionId를 connectionKey로 전달하여
   * 세션 전환 시 새 SSE 사이클을 만든다. lastEventId 변화는 재연결을 유발하지 않는다
   * (다음 자연 재연결 시 urlBuilder가 최신값을 부착).
   */
  connectionKey?: string;
  /** 인증 계정/서버 생명주기. 변경 시 이전 SSE를 닫고 고정 scope로 재연결한다. */
  scopeGeneration?: string;
  /** Fixed diagnostics bucket for this transport; no URL or event payload is retained. */
  diagnosticsSource?: Extract<DiagnosticSource, 'node_stream' | 'feed_stream' | 'chat_stream'>;
}

const INITIAL_RETRY_MS = 3000;
const MAX_RETRY_MS = 30000;
const MAX_RETRIES = 20;

export function useSSEStream({
  urlBuilder,
  eventTypes,
  onEvent,
  onError,
  onConnecting,
  onOpen,
  onSuspending,
  consumerFailureRef,
  enabled,
  connectionKey,
  scopeGeneration,
  diagnosticsSource,
}: UseSSEStreamOptions): void {
  const observedScopeGeneration = useAuthScopeGeneration();
  const effectiveScopeGeneration = scopeGeneration ?? observedScopeGeneration;
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  const onConnectingRef = useRef(onConnecting);
  const onOpenRef = useRef(onOpen);
  const onSuspendingRef = useRef(onSuspending);
  const diagnosticsSourceRef = useRef(diagnosticsSource);
  const eventTypesRef = useRef(eventTypes);
  const urlBuilderRef = useRef(urlBuilder);
  const failCurrentConnectionRef = useRef<(error: unknown) => void>(() => undefined);
  const effectGenerationRef = useRef(0);
  onEventRef.current = onEvent;
  onErrorRef.current = onError;
  onConnectingRef.current = onConnecting;
  onOpenRef.current = onOpen;
  onSuspendingRef.current = onSuspending;
  diagnosticsSourceRef.current = diagnosticsSource;
  eventTypesRef.current = eventTypes;
  urlBuilderRef.current = urlBuilder;
  if (consumerFailureRef) {
    consumerFailureRef.current = (error) => failCurrentConnectionRef.current(error);
  }

  useEffect(() => {
    if (!enabled) {
      failCurrentConnectionRef.current = () => undefined;
      return;
    }

    const capturedScope = captureAuthScope();
    if (capturedScope.generation !== effectiveScopeGeneration) return;

    let es: EventSource<string> | null = null;
    let cleanupCurrentEventSource: (() => void) | null = null;
    let retryCount = 0;
    let retryDelay = INITIAL_RETRY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let connectionGeneration = 0;
    const effectGeneration = ++effectGenerationRef.current;

    const isEffectActive = () =>
      !destroyed
      && effectGenerationRef.current === effectGeneration
      && isAuthScopeCurrent(capturedScope);

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const closeCurrentEventSource = () => {
      if (!cleanupCurrentEventSource) return;
      const source = diagnosticsSourceRef.current;
      const operation = source ? beginDiagnosticOperation(source, 11) : null;
      try {
        cleanupCurrentEventSource();
        cleanupCurrentEventSource = null;
        es = null;
        connectionGeneration += 1;
        if (source) recordSseConnection(source, 'close');
        if (source) endDiagnosticOperation(source, 11, operation);
      } catch (error) {
        if (source) recordSseConnection(source, 'error');
        if (source) endDiagnosticOperation(source, 11, operation, true);
        throw error;
      }
    };

    let wasBackgrounded = AppState.currentState === 'background';

    function connect() {
      if (!isEffectActive()) return;
      if (wasBackgrounded) return;
      closeCurrentEventSource();

      // 매 connect 시 urlBuilder를 호출하여 최신 URL을 얻는다 — retry 시 lastEventId가
      // 갱신되어 있으면 자연스럽게 resume URL이 만들어진다.
      const currentUrl = urlBuilderRef.current();
      const diagnosticsSource = diagnosticsSourceRef.current;
      const connectOperation = diagnosticsSource
        ? beginDiagnosticOperation(diagnosticsSource, 10)
        : null;
      if (!currentUrl) {
        if (diagnosticsSource) endDiagnosticOperation(diagnosticsSource, 10, connectOperation);
        return;
      }
      const connectionId = ++connectionGeneration;
      try {
        onConnectingRef.current?.();
      } catch (error) {
        if (diagnosticsSource) recordSseConnection(diagnosticsSource, 'error');
        if (diagnosticsSource) endDiagnosticOperation(diagnosticsSource, 10, connectOperation, true);
        throw error;
      }

      // JWT가 있으면 Authorization 헤더로 전달 — react-native-sse 1.x는 headers 옵션 지원.
      // URL query로 토큰을 노출하지 않는 편이 로그·프록시 측에서 토큰이 유출될 위험이 적다.
      const jwt = capturedScope.jwt;
      const options: EventSourceOptions = {
        pollingInterval: 0,
        ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
      };
      let currentEs: EventSource<string>;
      try {
        currentEs = new EventSource<string>(currentUrl, options);
      } catch (error) {
        if (diagnosticsSource) recordSseConnection(diagnosticsSource, 'error');
        if (diagnosticsSource) endDiagnosticOperation(diagnosticsSource, 10, connectOperation, true);
        throw error;
      }
      es = currentEs;
      if (diagnosticsSource) endDiagnosticOperation(diagnosticsSource, 10, connectOperation);

      const listeners: Array<{
        type: string;
        listener: (event: any) => void;
      }> = [];
      const isConnectionActive = () =>
        isEffectActive() &&
        connectionGeneration === connectionId &&
        es === currentEs;
      const failConnection = (
        error: unknown,
        { allowAuthFailure }: { allowAuthFailure: boolean },
      ) => {
        if (!isConnectionActive()) return;
        const source = diagnosticsSourceRef.current;
        if (source) recordSseConnection(source, 'error');
        closeCurrentEventSource();
        if (!isEffectActive()) return;

        const status = allowAuthFailure ? (error as any)?.xhrStatus : undefined;
        if (status === 401) {
          clearAuthForScope(capturedScope);
          destroyed = true;
          clearRetryTimer();
          return;
        }

        if (retryCount < MAX_RETRIES) {
          retryCount++;
          clearRetryTimer();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!isEffectActive()) return;
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
            connect();
          }, retryDelay);
        }
        try {
          onErrorRef.current?.(error);
        } catch {
          // 연결은 이미 닫혔고 retry도 예약됐다. 진단 callback 실패가 recovery를
          // 다시 끊거나 committed cursor를 바꾸지 못하게 한다.
        }
      };
      failCurrentConnectionRef.current = (error) => {
        failConnection(error, { allowAuthFailure: false });
      };
      const addListener = (type: string, listener: (event: any) => void) => {
        currentEs.addEventListener(type as any, listener as any);
        listeners.push({ type, listener });
      };
      cleanupCurrentEventSource = () => {
        for (const { type, listener } of listeners) {
          currentEs.removeEventListener(type as any, listener as any);
        }
        currentEs.close();
      };

      addListener('open', () => {
        if (!isConnectionActive()) return;
        if (diagnosticsSource) recordSseConnection(diagnosticsSource, 'open');
        retryCount = 0;
        retryDelay = INITIAL_RETRY_MS;
        // 호출자가 SSE 연결 단위 상태(예: catchup 게이트)를 리셋할 수 있도록
        // retry 카운터 정리 직후에 통지한다.
        onOpenRef.current?.();
      });

      addListener('error', (event) => {
        // A server-sent `event: error` is a data-bearing named event. Its
        // SESSION_EVENT_TYPES listener below owns semantic delivery; only a
        // transport error may close and reconnect this EventSource.
        if (event && typeof event === 'object' && 'data' in event) return;
        failConnection(event, { allowAuthFailure: true });
      });

      // 각 named event type에 리스너 등록
      for (const type of eventTypesRef.current) {
        addListener(type, (event: EventSourceEvent<string>) => {
          if (!isConnectionActive()) return;
          if ('data' in event) {
            let data: unknown;
            const rawData = (event as any).data;
            if (diagnosticsSource) {
              recordSseMessageBytes(
                diagnosticsSource,
                typeof rawData === 'string' ? utf8ByteLength(rawData) : 0,
              );
            }
            try {
              data = JSON.parse(rawData ?? '{}');
            } catch {
              // malformed JSON — skip
              return;
            }
            const eid: string = (event as any).lastEventId ?? '';
            try {
              onEventRef.current(type, data, eid);
            } catch (error) {
              // Store/consumer commit 실패 뒤 연결을 유지하면 다음 event가 실패한
              // event를 건너뛴 cursor를 확정할 수 있다. 마지막 committed cursor로
              // 재연결해 durable replay/text snapshot에 복구를 맡긴다.
              failConnection(error, { allowAuthFailure: false });
            }
          }
        });
      }
    }

    connect();

    // background를 거쳤다가 active로 돌아올 때 강제 reconnect.
    // iOS는 백그라운드 진입 시 EventSource 연결과 setTimeout을 정지·종료시키므로,
    // 포그라운드 복귀 시 SSE는 dead 상태로 멈춰 있고 retry timer도 발화하지 않을 수 있다.
    // 명시적으로 close → connect를 트리거하여 lastEventId resume 또는 새 연결을 만든다.
    //
    // 게이트는 previousAppState 1단계 검사가 아닌 wasBackgrounded 플래그 — iOS 일반
    // 복귀 경로는 background → inactive → active 3단계이며 1단계 검사로는 inactive에서
    // 깨진다. wasBackgrounded는 "한 번이라도 background를 거쳤는가"를 추적해 inactive
    // 경유와 무관하게 정확히 발화한다.
    //
    // active → inactive → active(Control Center, 앱 스위처 가림 등)는 background 미경유라
    // 플래그가 false이므로 자연 차단된다 — 불필요한 reconnect 회피.
    //
    // (SessionCard.tsx L114-144의 정책과 대칭: SessionCard는 background에서만 정지,
    //  여기서는 background를 거친 active 복귀에만 재시작.)
    //
    // wasBackgrounded는 effect 클로저 안에 선언 — connectionKey 변경으로 effect가
    // 재실행되면 새 클로저가 만들어져 자동 false로 리셋된다 (외부 ref 불필요).
    const appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
      // cleanup 후 큐잉되어 늦게 발화하는 콜백 방어. cleanup이 destroyed=true와
      // appStateSub.remove()를 모두 수행하므로 일반 경로에서는 도달하지 않지만,
      // 이미 큐에 들어간 콜백은 remove() 후에도 발화할 수 있다.
      if (destroyed) return;

      if (next === 'background') {
        wasBackgrounded = true;
        clearRetryTimer();
        const source = diagnosticsSourceRef.current;
        const cleanupOperation = source ? beginDiagnosticOperation(source, 12) : null;
        try {
          onSuspendingRef.current?.();
          if (source) endDiagnosticOperation(source, 12, cleanupOperation);
        } catch (error) {
          if (source) endDiagnosticOperation(source, 12, cleanupOperation, true);
          throw error;
        }
        closeCurrentEventSource();
        return;
      }
      if (next === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        // 기존 EventSource를 정리하고 새 사이클을 만든다.
        // retry 카운터·딜레이를 초기화하여 깨끗한 재연결 상태로 시작.
        clearRetryTimer();
        closeCurrentEventSource();
        retryCount = 0;
        retryDelay = INITIAL_RETRY_MS;
        connect();
      }
      // 'inactive'는 플래그를 변경하지 않고 통과 — wasBackgrounded 상태 보존.
    });

    return () => {
      destroyed = true;
      failCurrentConnectionRef.current = () => undefined;
      appStateSub.remove();
      clearRetryTimer();
      closeCurrentEventSource();
    };
    // urlBuilder는 ref 우회로 deps 제외. connectionKey 변경 시에만 새 SSE 사이클을 만든다.
  }, [enabled, connectionKey, effectiveScopeGeneration]);
}

// 카탈로그 스트림 이벤트 타입 (/api/sessions/stream)
// Phase 3: stream_meta(첫 이벤트, instance_id+latest_id) + replay_gap(서버가 ring buffer 부족 신호) 추가.
export const CATALOG_STREAM_EVENTS = [
  'stream_meta',
  'session_list',
  'session_created',
  'session_updated',
  'session_deleted',
  'catalog_updated',
  'metadata_updated',
  'folder_updated',
  'card_updated',
  'custom_view_updated',
  'page_updated',
  'replay_gap',
] as const;

export const NODE_STREAM_EVENTS = [
  'snapshot',
  'node_connected',
  'node_updated',
  'node_disconnected',
] as const;

// 세션 이벤트 스트림 타입 (/api/sessions/{id}/events)
export const SESSION_EVENT_TYPES = [
  'text_snapshot',
  'text_start',
  'text_delta',
  'text_end',
  'tool_start',
  'tool_result',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'user_message',
  'assistant_message',
  'turn_summary',
  // 서버는 intervention 발화 시 'intervention_sent' 타입으로 SSE를 보낸다.
  // 빌드 18까지는 'intervention'으로 잘못 구독하여 클라이언트에 도달하지 않았다.
  'intervention_sent',
  'session_notification',
  'system',
  'session_start',
  'session_ended',
  'complete',
  'result',
  'context_usage',
  'compact',
  'error',
  'input_request',
  'input_request_expired',
  'input_request_responded',
  'agent_updated',
  'handoff_requested',
  'handoff_occurred',
  'tool_approval_requested',
  'tool_approval_resolved',
  'guardrail_tripwire',
  'realtime_status',
  'realtime_transcript',
  'claude_runtime_session_state',
  'claude_runtime_task_started',
  'claude_runtime_task_created',
  'claude_runtime_task_updated',
  'claude_runtime_task_progress',
  'claude_runtime_task_completed',
  'claude_runtime_task_notification',
  'claude_runtime_notification',
  'claude_runtime_remote_trigger',
  'claude_runtime_transcript_mirror_error',
  'claude_runtime_hook_event',
  'claude_runtime_mode_state',
  'claude_runtime_schedule_updated',
  'claude_runtime_schedule_deleted',
  'history_sync',
] as const;
