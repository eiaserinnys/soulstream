import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type {
  ClaudeRuntimeNotification,
  ClaudeRuntimeRemoteTrigger,
} from '../../api/types';
import { useChatStore } from '../../store/chatStore';
import { DESIGN_ICON_SIZE, useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { RUNTIME_STRIP_DETAILS_MAX_HEIGHT } from './runtimeStripOverflow';
import { DisclosureIcon } from '../DisclosureIcon';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useClaudeRuntimeTasksRefresh } from './useClaudeRuntimeListRefresh';

interface Props {
  sessionId: string;
  api: ApiClient | null;
}

export function ClaudeRuntimeSignalsStrip({ sessionId, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const runtime = useChatStore((s) => s.claudeRuntimeBySession[sessionId]);
  const notifications = useMemo(
    () => Object.values(runtime?.notifications ?? {}).sort(compareUpdatedAt).slice(0, 3),
    [runtime],
  );
  const remoteTriggers = useMemo(
    () => Object.values(runtime?.remoteTriggers ?? {}).sort(compareUpdatedAt).slice(0, 3),
    [runtime],
  );
  const mirror = runtime?.transcriptMirror ?? null;
  const { loading, refresh } = useClaudeRuntimeTasksRefresh(sessionId, api, {
    automatic: false,
    errorTitle: '신호 조회 실패',
  });
  const [expanded, setExpanded] = useState(false);
  const errorCount = mirror?.errorCount ?? 0;
  const visibleCount = notifications.length + remoteTriggers.length + errorCount;

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  if (notifications.length === 0 && remoteTriggers.length === 0 && !mirror) return null;

  return (
    <View testID="runtime-signals-strip" style={styles.container}>
      <View style={styles.header}>
        <CompactTouchTarget
          testID="runtime-signals-header-touch"
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          frameStyle={styles.headerButton}
          surfaceStyle={styles.headerButtonSurface}
        >
          <DisclosureIcon
            expanded={expanded}
            color={t.colors.textMuted}
            size={t.iconSize.standard}
          />
          <Ionicons name="notifications-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          <Text style={styles.title} numberOfLines={1}>Runtime Signals</Text>
          <Text style={styles.badge}>{visibleCount}</Text>
          {errorCount > 0 ? <Text style={styles.errorBadge}>{errorCount} error</Text> : null}
        </CompactTouchTarget>
        <CompactTouchTarget
          testID="runtime-signals-refresh-touch"
          onPress={() => void refresh()}
          disabled={loading || !api}
          accessibilityLabel="런타임 신호 새로고침"
          frameStyle={(loading || !api) && styles.buttonDisabled}
          surfaceStyle={styles.iconButton}
          surfaceTestID="runtime-signals-refresh-visual"
        >
          {loading ? (
            <ActivityIndicator size="small" color={t.colors.textMuted} />
          ) : (
            <Ionicons name="refresh-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          )}
        </CompactTouchTarget>
      </View>
      {expanded ? (
        <ScrollView
          testID="runtime-signals-details-scroll"
          style={styles.detailsScroll}
          contentContainerStyle={styles.detailsContent}
          nestedScrollEnabled
        >
          {notifications.map((notification) => (
            <NotificationRow
              key={notification.notificationId}
              notification={notification}
              styles={styles}
              iconColor={t.colors.textMuted}
            />
          ))}
          {remoteTriggers.map((trigger) => (
            <RemoteTriggerRow
              key={trigger.triggerId}
              trigger={trigger}
              styles={styles}
              iconColor={t.colors.textMuted}
            />
          ))}
          {mirror ? (
            <View testID="runtime-signal-row-mirror" style={[styles.row, styles.errorRow]}>
              <Ionicons name="server-outline" color={t.colors.error} size={t.iconSize.compact} />
              <View style={styles.textColumn}>
                <View style={styles.titleRow}>
                  <Text style={[styles.kind, styles.errorKind]} numberOfLines={1} ellipsizeMode="tail">mirror</Text>
                  <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
                    {mirror.transcriptSessionId ?? mirror.projectKey ?? mirror.sessionId ?? 'transcript'}
                  </Text>
                  <Text style={styles.count}>{mirror.errorCount}</Text>
                </View>
                {mirror.lastError ? (
                  <Text style={[styles.summary, styles.errorText]} numberOfLines={1} ellipsizeMode="tail">
                    {mirror.lastError}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

function NotificationRow({
  notification,
  styles,
  iconColor,
}: {
  notification: ClaudeRuntimeNotification;
  styles: ReturnType<typeof makeStyles>;
  iconColor: string;
}) {
  return (
    <View testID={`runtime-signal-row-${notification.notificationId}`} style={styles.row}>
      <Ionicons name="notifications-outline" color={iconColor} size={DESIGN_ICON_SIZE.compact} />
      <View style={styles.textColumn}>
        <View style={styles.titleRow}>
          <Text style={styles.kind} numberOfLines={1} ellipsizeMode="tail">
            {notification.notificationType ?? notification.key ?? notification.source}
          </Text>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {notification.title ?? notification.message}
          </Text>
        </View>
        {notification.title && notification.message !== notification.title ? (
          <Text style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
            {notification.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function RemoteTriggerRow({
  trigger,
  styles,
  iconColor,
}: {
  trigger: ClaudeRuntimeRemoteTrigger;
  styles: ReturnType<typeof makeStyles>;
  iconColor: string;
}) {
  const label = trigger.originName
    ?? trigger.originFrom
    ?? trigger.triggerType
    ?? trigger.source;

  return (
    <View testID={`runtime-signal-row-${trigger.triggerId}`} style={styles.row}>
      <Ionicons name="radio-outline" color={iconColor} size={DESIGN_ICON_SIZE.compact} />
      <View style={styles.textColumn}>
        <View style={styles.titleRow}>
          <Text style={styles.kind} numberOfLines={1} ellipsizeMode="tail">remote</Text>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {label}
          </Text>
        </View>
        {trigger.prompt ? (
          <Text style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
            {trigger.prompt}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function compareUpdatedAt<T extends { updatedAt: number }>(left: T, right: T): number {
  return right.updatedAt - left.updatedAt;
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: {
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: 0,
      gap: t.uiSpacing.xs,
      backgroundColor: roles.chrome.tokenStyle.backgroundColor,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
    },
    headerButton: {
      flex: 1,
    },
    headerButtonSurface: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
    },
    title: {
      flex: 1,
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    badge: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textMuted,
      backgroundColor: c.surfaceMuted,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    errorBadge: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textPrimary,
      backgroundColor: `${c.error}1A`,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    detailsScroll: {
      maxHeight: RUNTIME_STRIP_DETAILS_MAX_HEIGHT,
    },
    detailsContent: {
      gap: t.uiSpacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: t.foundation.minHeight.tool,
      gap: t.uiSpacing.xs,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xs,
    },
    errorRow: {
      backgroundColor: `${c.error}0D`,
    },
    textColumn: { flex: 1, minWidth: 0 },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
      minWidth: 0,
    },
    kind: {
      maxWidth: '34%',
      flexShrink: 1,
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 4,
      paddingHorizontal: t.uiSpacing.xs,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textMuted,
      backgroundColor: c.surfaceMuted,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    errorKind: {
      color: c.textPrimary,
      backgroundColor: `${c.error}1A`,
    },
    rowTitle: {
      flex: 1,
      color: c.textPrimary,
      fontSize: t.fontSize.body,
      fontWeight: '600',
    },
    summary: {
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      marginTop: t.uiSpacing.xxs,
    },
    errorText: { color: c.errorText },
    count: {
      color: c.textMuted,
      fontSize: t.fontSize.meta,
      fontVariant: ['tabular-nums'],
    },
    iconButton: {
      width: t.controlHeight.chip,
      height: t.controlHeight.chip,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 15,
    },
    buttonDisabled: { opacity: 0.45 },
  });
}
