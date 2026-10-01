import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  Pressable,
  type GestureResponderEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Session } from '../api/types';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { getSessionDisplayName } from '../lib/session-display-name';
import { useTokens } from '../theme';
import {
  resolveSessionCardAvatar,
  resolveSessionCardCaller,
  resolveSessionAgentLabel,
  resolveSessionModelLabel,
} from './sessionCardDisplay';
import { shouldRenderSessionCardShimmer } from './sessionCardAnimation';
import { useSessionCardAnimation } from './useSessionCardAnimation';
import { useSessionReviewAcknowledge } from './useSessionReviewAcknowledge';
import { makeSessionCardStyles } from './sessionCardFrame';
import { AppGlassCard } from './AppGlassCard';
import { CompactTouchTarget } from './CompactTouchTarget';
import { formatRelativeTime } from '../lib/relative-time';
import { sessionNeedsReview } from '../lib/session-review';
import { getSessionFeedActivityTimestamp } from '../lib/session-feed-activity';

interface Props {
  session: Session;
  onPress: () => void;
  onLongPress?: () => void;
  testID?: string;
  surfaceTestID?: string;
  avatarTestID?: string;
  timeTestID?: string;
  small?: boolean;
  embedded?: boolean;
  accessibilityLabelPrefix?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// '#RRGGBB' + 0..1 알파 → '#RRGGBBAA'. CSS color-mix(success X%, transparent) 등가.
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `${hex}${a}`;
}

const STATUS_LABELS: Record<string, string> = {
  running: '실행 중',
  idle: '대기',
  completed: '완료',
  error: '오류',
};

export function SessionCard({
  session,
  onPress,
  onLongPress,
  testID = 'session-card-pressable',
  surfaceTestID,
  avatarTestID = 'session-card-agent-avatar',
  timeTestID = 'session-card-time',
  small = false,
  embedded = false,
  accessibilityLabelPrefix,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeSessionCardStyles(t, embedded, small), [small, embedded, t]);

  const folderName = useSessionStore((s) => {
    const assignment = s.catalog.sessions[session.agentSessionId];
    if (!assignment?.folderId) return null;
    return s.catalog.folders.find((folder) => folder.id === assignment.folderId)?.name ?? null;
  });
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);

  // 표시명 폴백 정본은 lib/session-display-name.ts (카드·채팅 헤더 공용).
  const displayName = getSessionDisplayName(session, session.agentSessionId);
  const statusColor = (() => {
    switch (session.status) {
      case 'running':
        return t.colors.statusRunning;
      case 'completed':
        return t.colors.statusCompleted;
      case 'error':
        return t.colors.statusError;
      default:
        return t.colors.statusIdle;
    }
  })();
  const statusLabel = STATUS_LABELS[session.status] ?? session.status;
  const agentLabel = resolveSessionAgentLabel(session);

  const avatar = useMemo(
    () => resolveSessionCardAvatar(session, serverUrl),
    [session.agentName, session.agentId, session.agentSessionId, session.agentPortraitUrl, serverUrl],
  );

  const caller = useMemo(
    () => resolveSessionCardCaller(session, serverUrl),
    [session.callerSessionId, session.userName, session.userPortraitUrl, serverUrl],
  );

  const isRunning = session.status === 'running';
  const needsReview = sessionNeedsReview(session);
  const firstPendingAttention = session.pendingAttentions?.[0];
  const pendingAttentionCount = session.pendingAttentions?.length ?? 0;
  const pendingAttentionLabel = pendingAttentionCount > 0
    ? `응답 필요${pendingAttentionCount > 1
      ? ` ${pendingAttentionCount > 99 ? '99+' : pendingAttentionCount}`
      : ''}`
    : null;
  const { acknowledge: acknowledgeSessionReview, inFlight: acknowledgingReview } =
    useSessionReviewAcknowledge(session.agentSessionId);
  const [cardWidth, setCardWidth] = useState(0);
  const { pulse, shimmer, reducedMotion, appActive, animationEnabled } =
    useSessionCardAnimation({ isRunning });

  const successHex = t.colors.statusRunning;

  // foreground running 세션에만 animation을 적용한다.
  const animatedCardStyle =
    animationEnabled
      ? {
          backgroundColor: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [withAlpha(successHex, 0), withAlpha(successHex, 0.07)],
          }),
          borderColor: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [
              withAlpha(successHex, 0.12),
              withAlpha(successHex, 0.5),
            ],
          }),
          shadowColor: successHex,
          shadowOffset: { width: 0, height: 0 },
          shadowRadius: 14,
          shadowOpacity: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 0.14],
          }),
          // Android 정적 근사 (styles.card.elevation:0을 오버라이드).
          // elevation은 Animated 보간이 제한적이라 고정값으로 근사.
          elevation: 4,
        }
      : null;

  const shimmerTranslate = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-cardWidth, cardWidth],
  });
  const showShimmer = shouldRenderSessionCardShimmer({
    isRunning,
    reducedMotion,
    appActive,
    cardWidth,
  });

  const acknowledgeReview = (event: GestureResponderEvent) => {
    event.stopPropagation();
    void acknowledgeSessionReview();
  };
  const modelLabel = resolveSessionModelLabel(session);
  const activityTimestamp = getSessionFeedActivityTimestamp(session) ?? '';
  // 모델 라벨은 에이전트 이름 바로 옆에 둔다 — 에이전트 이름만으로는
  // 실행 모델을 알 수 없다는 것이 이 표시의 출발점이라 둘이 붙어 있어야 한다.
  const identityText = [agentLabel, modelLabel, caller.requestLabel]
    .filter(Boolean)
    .join(' · ');
  const contextText = [folderName, session.nodeId].filter(Boolean).join(' · ');
  const accessibilityLabel = [
    accessibilityLabelPrefix,
    displayName,
    pendingAttentionLabel ?? (needsReview ? '검수 필요' : statusLabel),
    firstPendingAttention?.title,
    firstPendingAttention?.requiresDetail ? '상세에서 확인' : null,
    agentLabel,
    caller.accessibilityLabel,
    contextText,
    modelLabel,
    formatRelativeTime(activityTimestamp),
  ].filter(Boolean).join(', ');

  const avatarView = (avatar.uri ? (
        <Image
          testID={avatarTestID}
          source={{
            uri: avatar.uri,
            ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
          }}
          style={styles.avatar}
        />
      ) : (
        <View testID={avatarTestID} style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarFallbackText}>{avatar.fallbackChar}</Text>
        </View>
      ));

  return (
    <AppGlassCard testID={surfaceTestID} style={styles.cardSurface} isInteractive>
      <AnimatedPressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[styles.card, animatedCardStyle]}
        onPress={onPress}
        onLongPress={onLongPress}
        onLayout={(e) => {
          const next = e.nativeEvent.layout.width;
          // 동일 폭 재발화 시 setState 스킵 — 백그라운드 진입 중 surface 재측정으로
          // 같은 width onLayout이 다시 들어와 불필요한 리렌더를 유발하는 것을 차단.
          setCardWidth((prev) => (prev === next ? prev : next));
        }}
        android_ripple={{ color: t.colors.border }}
      >
      {showShimmer && (
        <View
          testID="session-card-shimmer-layer"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: t.radius.md,
              overflow: 'hidden',
              pointerEvents: 'none',
            },
          ]}
        >
          <Animated.View
            style={{
              width: '100%',
              height: '100%',
              transform: [{ translateX: shimmerTranslate }],
            }}
          >
            <LinearGradient
              // 웹 정본: linear-gradient(105deg, transparent 30%, success 10% 50%, transparent 70%).
              // RN LinearGradient는 deg 직접 지원 안 함 → start/end 좌표로 대각선 표현.
              colors={[
                'transparent',
                withAlpha(successHex, 0.1),
                'transparent',
              ]}
              locations={[0.3, 0.5, 0.7]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
      )}

      {avatarView}
      <View style={styles.content}>
        <View style={styles.primaryColumn}>
          <View testID="session-card-title-row" style={styles.titleRow}>
            <Text
              testID="session-card-title"
              style={styles.name}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {displayName}
            </Text>
          </View>
          <View testID="session-card-identity-row" style={styles.identityRow}>
            <Text
              testID="session-card-identity"
              style={styles.identity}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {small ? [agentLabel, session.nodeId, modelLabel ?? session.modelPreset].filter(Boolean).join(' · ') : identityText}
            </Text>
          </View>
          {!small && <View testID="session-card-context-row" style={styles.contextRow}>
            <Text
              testID="session-card-context"
              style={styles.context}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {contextText}
            </Text>
          </View>}
        </View>
        <View testID="session-card-right-rail" style={styles.rightRail}>
          {pendingAttentionLabel ? (
            <View
              testID="session-card-status-chip"
              style={[styles.statusChip, styles.attentionChip]}
            >
              <Text style={[styles.statusChipText, styles.attentionChipText]}>
                {pendingAttentionLabel}
              </Text>
            </View>
          ) : needsReview ? (
            <CompactTouchTarget
              testID="session-card-review-ack"
              accessibilityRole="button"
              accessibilityLabel="검수 결과 확인"
              accessibilityHint="이 세션의 결과를 확인한 것으로 표시합니다"
              disabled={acknowledgingReview}
              onPress={acknowledgeReview}
              frameStyle={styles.reviewTouchFrame}
              surfaceStyle={styles.reviewButton}
              surfaceTestID="session-card-status-chip"
            >
              {acknowledgingReview ? (
                <ActivityIndicator size="small" color={t.colors.warningText} />
              ) : (
                <Text style={styles.reviewButtonText}>검수 필요</Text>
              )}
            </CompactTouchTarget>
          ) : (
            <View
              testID="session-card-status-chip"
              style={[
                styles.statusChip,
                { backgroundColor: withAlpha(statusColor, 0.12) },
              ]}
            >
              <Text style={[styles.statusChipText, { color: statusColor }]}>
                {statusLabel}
              </Text>
            </View>
          )}
          <Text testID={timeTestID} style={styles.time} numberOfLines={1}>
            {formatRelativeTime(activityTimestamp)}
          </Text>
        </View>
      </View>
      </AnimatedPressable>
    </AppGlassCard>
  );
}
