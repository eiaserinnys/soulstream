import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import {
  createSessionSuccessionFailureRecord,
  enqueueSessionSuccessionFailure,
  type SessionSuccessionFailureRecord,
} from '../../lib/session-succession-diagnostics';
import { reportSanitizedEasObserveError } from '../../lib/eas-observe-crash-reporting';

interface FailureContext {
  folderId: string;
  folderPageId: string;
  projectPageId: string | null;
  visible: boolean;
  predecessorSessionId: string | null;
  folderBlockCount: number;
  folderSessionCount: number;
}

interface State {
  failed: boolean;
  record: SessionSuccessionFailureRecord | null;
}

interface BoundaryProps {
  resetKey: string;
  failureContext: FailureContext;
  renderFallback(record: SessionSuccessionFailureRecord): ReactNode;
  onEmergencyClose(): void;
  children: ReactNode;
}

export class SessionSuccessionErrorBoundary extends React.Component<BoundaryProps, State> {
  state: State = { failed: false, record: null };

  static getDerivedStateFromError(): State {
    return { failed: true, record: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportSanitizedEasObserveError(error, 'session-succession-render');
    const record = safelyCreateRecord(
      this.props.failureContext,
      'render',
      error,
      info.componentStack ?? null,
    );
    if (!record) return;
    this.setState({ failed: true, record });
    safelyEnqueue(record);
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, record: null });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.state.record) {
      return (
        <SessionSuccessionEmergencyFallback
          message="오류 정보를 준비하지 못했습니다."
          onClose={this.props.onEmergencyClose}
        />
      );
    }
    return (
      <SessionSuccessionFallbackBoundary
        key={this.props.resetKey}
        failureContext={this.props.failureContext}
        originalRecord={this.state.record}
        onClose={this.props.onEmergencyClose}
      >
        <FallbackRenderer
          record={this.state.record}
          renderFallback={this.props.renderFallback}
        />
      </SessionSuccessionFallbackBoundary>
    );
  }
}

function FallbackRenderer({
  record,
  renderFallback,
}: {
  record: SessionSuccessionFailureRecord;
  renderFallback(record: SessionSuccessionFailureRecord): ReactNode;
}) {
  return renderFallback(record);
}

class SessionSuccessionFallbackBoundary extends React.Component<{
  failureContext: FailureContext;
  originalRecord: SessionSuccessionFailureRecord;
  onClose(): void;
  children: ReactNode;
}, { failed: boolean; message: string | null }> {
  state = { failed: false, message: null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: safeErrorText(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportSanitizedEasObserveError(error, 'session-succession-fallback');
    const record = safelyCreateRecord(
      this.props.failureContext,
      'fallback',
      error,
      info.componentStack ?? null,
    );
    if (!record) return;
    this.setState({ failed: true, message: record.error.message });
    safelyEnqueue(record);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <SessionSuccessionEmergencyFallback
        message={this.state.message ?? this.props.originalRecord.error.message}
        onClose={this.props.onClose}
      />
    );
  }
}

function SessionSuccessionEmergencyFallback({
  message,
  onClose,
}: {
  message: string;
  onClose(): void;
}) {
  return (
    <View testID="succession-emergency-fallback" style={styles.emergency}>
      <Text style={styles.title}>새 세션 화면을 안전하게 닫았습니다.</Text>
      <Text selectable style={styles.message}>{message}</Text>
      <Text style={styles.hint}>오류 정보는 설정의 앱 진단 기록에 저장했습니다.</Text>
      <Button
        testID="succession-emergency-close"
        title="닫기"
        onPress={onClose}
      />
    </View>
  );
}

function safelyEnqueue(record: SessionSuccessionFailureRecord) {
  try {
    void enqueueSessionSuccessionFailure(record).catch((error) => {
      safeWarn('[SessionSuccession] diagnostic enqueue failed:', error);
    });
  } catch (error) {
    safeWarn('[SessionSuccession] diagnostic enqueue failed:', error);
  }
}

function safelyCreateRecord(
  failureContext: FailureContext,
  phase: 'render' | 'fallback',
  error: unknown,
  componentStack: string | null,
): SessionSuccessionFailureRecord | null {
  try {
    return createSessionSuccessionFailureRecord({
      ...failureContext,
      phase,
      error,
      componentStack,
    });
  } catch (diagnosticError) {
    safeWarn('[SessionSuccession] diagnostic record creation failed:', diagnosticError);
    return null;
  }
}

function safeWarn(message: string, error: unknown) {
  try {
    console.warn(message, error);
  } catch {
    // 경계의 진단 부가기능은 렌더 복구 경로를 다시 깨뜨리지 않는다.
  }
}

function safeErrorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || '알 수 없는 fallback 오류';
    return String(error);
  } catch {
    return 'fallback 오류 세부 정보를 읽지 못했습니다.';
  }
}

const styles = StyleSheet.create({
  emergency: {
    ...StyleSheet.absoluteFill,
    zIndex: 10000,
    elevation: 10000,
    backgroundColor: '#111827',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  message: {
    color: '#FCA5A5',
  },
  hint: {
    color: '#D1D5DB',
  },
});
