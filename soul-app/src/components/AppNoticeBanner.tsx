import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppNoticeStore } from '../store/appNoticeStore';
import { useTokens, type DesignTokens } from '../theme';
import { AppGlassCard } from './AppGlassCard';

const DEFAULT_AUTO_DISMISS_MS = 3500;

interface AppNoticeBannerProps {
  autoDismissMs?: number;
}

/**
 * 앱 전역의 비차단 결과 알림. Safe Area 아래 상단에 한 번만 마운트한다.
 */
export function AppNoticeBanner({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: AppNoticeBannerProps) {
  const notice = useAppNoticeStore((state) => state.notice);
  const dismissNotice = useAppNoticeStore((state) => state.dismissNotice);
  const insets = useSafeAreaInsets();
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      dismissNotice(notice.id);
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, dismissNotice, notice]);

  if (!notice) return null;

  const toneColor = notice.tone === 'success' ? t.colors.success : t.colors.error;

  return (
    <View
      testID="app-notice-viewport"
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.viewport,
        {
          paddingTop: insets.top + t.uiSpacing.sm,
          paddingHorizontal: t.foundation.pageInset,
        },
      ]}
    >
      <View
        testID="app-notice-banner"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={styles.bannerFrame}
      >
        <AppGlassCard
          role="modal"
          style={[styles.bannerSurface, { borderColor: toneColor }]}
        >
          <View style={[styles.toneBar, { backgroundColor: toneColor }]} />
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1}>
              {notice.title}
            </Text>
            <Text style={styles.message} numberOfLines={2}>
              {notice.message}
            </Text>
          </View>
        </AppGlassCard>
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    viewport: {
      zIndex: 1000,
      elevation: 1000,
      alignItems: 'center',
      justifyContent: 'flex-start',
    },
    bannerFrame: {
      width: '100%',
      maxWidth: 560,
    },
    bannerSurface: {
      width: '100%',
      minHeight: t.foundation.minHeight.secondary,
      flexDirection: 'row',
      alignItems: 'stretch',
      overflow: 'hidden',
      borderWidth: 1,
      borderRadius: t.foundation.radius.row,
    },
    toneBar: {
      width: t.uiSpacing.xs,
    },
    copy: {
      flex: 1,
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: t.uiSpacing.sm,
      gap: t.uiSpacing.xxs,
    },
    title: {
      ...t.foundation.typography.label,
      color: t.colors.textPrimary,
    },
    message: {
      ...t.foundation.typography.meta,
      color: t.colors.textSecondary,
    },
  });
}
