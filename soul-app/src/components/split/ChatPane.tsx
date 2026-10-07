import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store/sessionStore';
import { StatusDot } from '../chat/StatusDot';
import { ChatBody } from '../chat/ChatBody';
import { getSessionDisplayName } from '../../lib/session-display-name';
import { useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { TabletPaneHeader } from './TabletPaneHeader';
import { resolveTabletBottomSafeAreaPadding } from './tabletShellInsets';

/**
 * 우측 채팅 패널 — 상단 인라인 헤더(상태 도트 + 세션 이름) + ChatBody.
 */
export function ChatPane({ active = true, sessionId: sessionIdOverride, onClose, ownsSessionConnection = true }: {
  active?: boolean; sessionId?: string | null; onClose?: () => void; ownsSessionConnection?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const minimumBottomPadding = resolveTabletBottomSafeAreaPadding(
    insets.bottom,
    t.tabletShell.outerInset,
  );

  const independentSession = sessionIdOverride !== undefined;
  const activeSessionId = useUIStore((s) => independentSession ? null : s.activeSessionId);
  const sessionId = sessionIdOverride === undefined ? activeSessionId : sessionIdOverride;
  const focusEventId = useUIStore((s) => independentSession ? null : s.focusEventId);
  const storyOpenRequestId = useUIStore((s) => independentSession ? null : s.storyOpenRequestId);
  const clearFocusEventId = useUIStore((s) => independentSession ? undefined : s.clearFocusEventId);
  const clearStoryOpenRequestId = useUIStore(
    (s) => independentSession ? undefined : s.clearStoryOpenRequestId,
  );
  const session = useSessionStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined
  );

  return (
    <View style={styles.container}>
      <TabletPaneHeader
        testID="tablet-chat-header"
        style={styles.headerSurface}
      >
        {sessionId ? (
          <>
            <StatusDot status={session?.status} />
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
              {getSessionDisplayName(session, sessionId)}
            </Text>
            <View style={styles.spacer} />
            {/* 챗 닫기 — 우측 패널을 빈 상태로 되돌리고 싶을 때 사용. */}
            <TouchableOpacity
              testID="tablet-chat-close"
              style={styles.closeButton}
              onPress={onClose ?? (() => useUIStore.getState().setActiveSessionId(null))}
              accessibilityLabel="챗 닫기"
            >
              <Ionicons
                name="close-outline"
                color={t.colors.textMuted}
                size={t.iconSize.prominent}
              />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Ionicons
              name="chatbubble-ellipses-outline"
              color={t.colors.textMuted}
              size={t.iconSize.standard}
            />
            <Text style={styles.titleEmpty}>채팅</Text>
          </>
        )}
      </TabletPaneHeader>

      <View style={{ flex: 1 }}>
        <ChatBody
          sessionId={sessionId ?? undefined}
          active={active}
          ownsSessionConnection={ownsSessionConnection}
          minimumBottomPadding={minimumBottomPadding}
          focusEventId={independentSession ? undefined : focusEventId}
          storyOpenRequestId={independentSession ? undefined : storyOpenRequestId}
          onFocusEventHandled={clearFocusEventId}
          onStoryOpenRequestHandled={clearStoryOpenRequestId}
        />
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    headerSurface: {
      ...roles.glassDense.tokenStyle,
      borderWidth: 0,
      borderRadius: 0,
    },
    title: {
      color: c.textPrimary,
      ...t.foundation.typography.navigation,
      flexShrink: 1,
    },
    titleEmpty: {
      color: c.textMuted,
      fontSize: t.fontSize.rowTitle,
      fontWeight: '500',
    },
    spacer: { flex: 1 },
    closeButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
