import React, { createContext, useContext, useMemo, useState, useEffect } from 'react';
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
import { resolveChatPaneMinimumBottomPadding } from './tabletShellInsets';
import { useDuoSideBand } from '../../navigation/duoSideBand';
import { useRegisterDuoRailOverride } from '../../navigation/phoneRailActions';
import { SessionFilesContent, FilesTitle, RefreshButton } from '../../screens/SessionFilesScreen';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { usePlannerContextMenus } from '../../hooks/usePlannerContextMenus';
import { SessionSuccessionHost } from '../planner/SessionSuccessionHost';
import { openPlannerSessionWorkspace } from '../../lib/planner-folder-workspace';

/** A containing card panel may provide the bottom clearance it actually reserves. */
export const ChatPaneMinimumBottomPaddingContext = createContext<number | undefined>(undefined);

/**
 * 우측 채팅 패널 — 상단 인라인 헤더(상태 도트 + 세션 이름) + ChatBody.
 */
export function ChatPane({ active = true, sessionId: sessionIdOverride, onClose, ownsSessionConnection = true, headerLeading }: {
  active?: boolean; sessionId?: string | null; onClose?: () => void; ownsSessionConnection?: boolean;
  /** 헤더 왼쪽에 붙는 슬롯. 좁은 단일 열에서 상세로 돌아가는 버튼이 들어온다. */
  headerLeading?: React.ReactNode;
}) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesHeader, setFilesHeader] = useState<React.ComponentProps<typeof FilesTitle>['header']>(null);
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const menus = usePlannerContextMenus(api);
  const panelMinimumBottomPadding = useContext(ChatPaneMinimumBottomPaddingContext);
  const minimumBottomPadding = resolveChatPaneMinimumBottomPadding(
    panelMinimumBottomPadding,
    insets.bottom,
    t.tabletShell.outerInset,
  );

  const independentSession = sessionIdOverride !== undefined;
  const activeSessionId = useUIStore((s) => independentSession ? null : s.activeSessionId);
  const sessionId = sessionIdOverride === undefined ? activeSessionId : sessionIdOverride;
  useEffect(() => { setFilesOpen(false); }, [sessionId]);
  useRegisterDuoRailOverride('chat-pane-files', duo && active && filesOpen, [
    { id: 'back', label: '대화로 돌아가기', icon: 'chevron-back', onPress: () => setFilesOpen(false) },
    { id: 'refresh', label: '다시 읽기', icon: 'refresh', disabled: !filesHeader || filesHeader.disabled, onPress: () => { if (filesHeader && !filesHeader.disabled) filesHeader.refresh(); } },
  ]);
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
        {filesOpen && sessionId ? <>
          <LiquidGlassButton iconOnly variant="plain" accessibilityLabel="대화로 돌아가기" onPress={() => setFilesOpen(false)}><Ionicons name="arrow-back" size={t.iconSize.navigation} color={t.colors.textPrimary} /></LiquidGlassButton>
          <FilesTitle header={filesHeader} /><View style={styles.spacer} /><RefreshButton header={filesHeader} />
        </> : <>
        {!duo ? headerLeading : null}
        {sessionId ? (
          <>
            <StatusDot status={session?.status} />
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
              {getSessionDisplayName(session, sessionId)}
            </Text>
            <View style={styles.spacer} />
            <LiquidGlassButton iconOnly variant="plain" accessibilityLabel="세션 파일" onPress={() => setFilesOpen(true)}><Ionicons name="folder-open-outline" color={t.colors.accent} size={t.iconSize.navigation} /></LiquidGlassButton>
            <LiquidGlassButton iconOnly variant="plain" accessibilityLabel="세션 메뉴" onPress={() => menus.openSessionMenu({ sessionId })}><Ionicons name="ellipsis-horizontal" color={t.colors.accent} size={t.iconSize.navigation} /></LiquidGlassButton>
            {/* 챗 닫기 — 우측 패널을 빈 상태로 되돌리고 싶을 때 사용. */}
            {!duo ? <TouchableOpacity
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
            </TouchableOpacity> : null}
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
        </>}
      </TabletPaneHeader>

      {filesOpen && sessionId ? <SessionFilesContent sessionId={sessionId} active={active} onHeader={setFilesHeader} /> : <View style={{ flex: 1 }}>
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
      </View>}
      <SessionSuccessionHost
        api={api}
        request={menus.sessionSuccession}
        onClose={menus.closeSessionSuccession}
        onCreated={(createdSessionId) => { void openPlannerSessionWorkspace(createdSessionId); }}
      />
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
