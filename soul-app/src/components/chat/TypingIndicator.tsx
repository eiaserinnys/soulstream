import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { Session } from '../../api/types';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useTokens, type DesignTokens } from '../../theme';
import { ThinkingOrb } from './ThinkingOrb';

interface Props {
  session?: Session;
}

/**
 * thinking-orbs의 working/orbits 20px 포트를 사용하는 "생각 중" 인디케이터.
 *
 * AssistantMessage와 같은 좌측 아바타 + 버블 레이아웃을 따르고,
 * 오브 오른쪽에 웹 표면과 같은 작은 안내 문구를 표시한다.
 *
 * ChatScreen은 session.status === 'running'일 때만 이 컴포넌트를 inverted FlatList의
 * 가장 첫 항목(= 화면 가장 아래)에 끼워 넣는다.
 */
export function TypingIndicator({ session }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);

  const avatarUri = (() => {
    if (!session?.agentPortraitUrl || !serverUrl) return null;
    return session.agentPortraitUrl.startsWith('http')
      ? session.agentPortraitUrl
      : `${serverUrl.replace(/\/$/, '')}${session.agentPortraitUrl}`;
  })();
  const fallbackChar =
    session?.agentName?.[0] ?? session?.displayName?.[0] ?? '·';

  return (
    <View style={styles.row}>
      {avatarUri ? (
        <Image
          source={{
            uri: avatarUri,
            ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
          }}
          style={styles.avatar}
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarFallbackText}>{fallbackChar}</Text>
        </View>
      )}
      <View
        testID="typing-indicator-bubble"
        accessibilityLabel="생각 중입니다…"
        style={styles.bubble}
      >
        <ThinkingOrb
          inkColor={t.colors.textPrimary}
          surfaceColor={t.colors.surface}
        />
        <Text style={styles.label}>생각 중입니다…</Text>
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const AVATAR = t.avatarSize.message;
  const c = t.colors;
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginVertical: t.spacing.xs,
      marginHorizontal: t.spacing.md,
      gap: t.spacing.sm,
    },
    avatar: {
      width: AVATAR,
      height: AVATAR,
      borderRadius: AVATAR / 2,
      backgroundColor: c.border,
      marginTop: t.spacing.xxs,
    },
    avatarFallback: { alignItems: 'center', justifyContent: 'center' },
    avatarFallbackText: {
      color: c.textMuted,
      fontSize: t.chatFontSize.meta,
      fontWeight: '600',
    },
    bubble: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      backgroundColor: c.surface,
      borderRadius: t.radius.lg,
      borderBottomLeftRadius: 4,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    label: {
      color: c.textMuted,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
  });
}
