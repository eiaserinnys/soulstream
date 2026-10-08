import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ApiClient } from '../../api/client';
import type { SessionStoryResponse } from '../../api/sessionEndpoints';
import { useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';
import { GlassButton } from '../GlassSurface';
import { chatAuxiliarySurface } from './chatAuxiliarySurface';

interface Props {
  presentation?: 'default' | 'manuscript';
  mode?: 'disclosure' | 'settings';
  sessionId: string;
  api: Pick<ApiClient, 'getSessionStory'> | null;
  openRequestId?: number | null;
  onOpenRequestHandled?: () => void;
}

interface SessionStoryPresentation {
  highlight: string | null;
  narrative: string | null;
  unfoldedContents: string[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'hidden' | 'error';

export function SessionStoryPanel({
  sessionId,
  api,
  openRequestId = null,
  onOpenRequestHandled,
  presentation = 'default',
  mode = 'disclosure',
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [story, setStory] = useState<SessionStoryPresentation | null>(null);
  const [developmentFailure, setDevelopmentFailure] = useState<Error | null>(null);
  const requestGeneration = useRef(0);
  const handledOpenRequest = useRef<number | null>(null);
  const requestContext = useRef({ api, sessionId });
  const requestContextChanged = (
    requestContext.current.api !== api
    || requestContext.current.sessionId !== sessionId
  );
  const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__;

  useEffect(() => {
    requestContext.current = { api, sessionId };
    requestGeneration.current += 1;
    setExpanded(false);
    setLoadState('idle');
    setStory(null);
    setDevelopmentFailure(null);
    handledOpenRequest.current = null;
  }, [api, mode, sessionId]);

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const loadStory = useCallback(async () => {
    if (!api) {
      if (mode === 'settings') setLoadState('error');
      return;
    }
    const generation = ++requestGeneration.current;
    setLoadState('loading');
    try {
      const response = await api.getSessionStory(sessionId);
      if (requestGeneration.current !== generation) return;
      const nextStory = projectSessionStory(response, isDevelopmentBuild, mode);
      if (!nextStory) {
        setExpanded(false);
        setLoadState('hidden');
        return;
      }
      setStory(nextStory);
      setLoadState('ready');
    } catch (error: unknown) {
      if (requestGeneration.current !== generation) return;
      if (mode === 'settings') {
        setLoadState('error');
        return;
      }
      if (isDevelopmentBuild) {
        setDevelopmentFailure(
          error instanceof Error
            ? error
            : new Error(`[SessionStoryPanel] ${String(error)}`),
        );
        return;
      }
      setExpanded(false);
      setLoadState('hidden');
    }
  }, [api, isDevelopmentBuild, mode, sessionId]);

  const expand = useCallback((forceLoad = false) => {
    setExpanded(true);
    if (!api || (!forceLoad && loadState !== 'idle')) return;
    void loadStory();
  }, [api, loadState, loadStory]);

  const toggle = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    expand();
  }, [expand, expanded]);

  useEffect(() => {
    if (mode === 'settings') return;
    if (
      openRequestId === null
      || handledOpenRequest.current === openRequestId
    ) {
      return;
    }
    handledOpenRequest.current = openRequestId;
    expand(requestContextChanged);
    onOpenRequestHandled?.();
  }, [
    expand,
    mode,
    onOpenRequestHandled,
    openRequestId,
    requestContextChanged,
  ]);

  useEffect(() => {
    if (mode === 'settings') void loadStory();
  }, [loadStory, mode]);

  if (mode !== 'settings' && isDevelopmentBuild && developmentFailure) {
    throw developmentFailure;
  }
  if (mode !== 'settings' && (!api || loadState === 'hidden')) return null;

  if (mode === 'settings') {
    return (
      <View testID="session-story-panel" style={styles.settingsRoot}>
        {loadState === 'loading' ? (
          <View testID="session-story-loading" accessibilityRole="progressbar" style={styles.settingsLoading}>
            <ActivityIndicator color={t.colors.textTertiary} />
            <Text style={styles.settingsCopy}>스토리를 불러오는 중입니다.</Text>
          </View>
        ) : null}
        {loadState === 'error' ? (
          <View style={styles.settingsError}>
            <Text accessibilityRole="alert" style={styles.settingsEmpty}>스토리를 불러오지 못했습니다.</Text>
            <GlassButton
              variant="plain"
              testID="session-story-retry"
              accessibilityLabel="스토리 다시 시도"
              onPress={() => void loadStory()}
            >
              <Text style={styles.settingsRetryText}>다시 시도</Text>
            </GlassButton>
          </View>
        ) : null}
        {loadState === 'ready' && story ? <StoryContent story={story} styles={styles} mode="settings" /> : null}
      </View>
    );
  }

  return (
    <View testID="session-story-panel" style={[styles.container, chatAuxiliarySurface(t, presentation)]}>
      <TouchableOpacity
        testID="session-story-toggle"
        accessibilityRole="button"
        accessibilityLabel={`세션 스토리 ${expanded ? '접기' : '펼치기'}`}
        accessibilityState={{ expanded }}
        style={styles.header}
        onPress={toggle}
      >
        <Text style={styles.headerTitle}>세션 스토리</Text>
        <DisclosureIcon expanded={expanded} tone="tertiary" />
      </TouchableOpacity>

      {expanded ? (
        loadState === 'loading' ? (
          <View testID="session-story-loading" style={styles.loading}>
            <ActivityIndicator color={t.colors.textTertiary} />
          </View>
        ) : story ? (
          <ScrollView
            testID="session-story-scroll"
            style={styles.scroll}
            contentContainerStyle={styles.content}
            nestedScrollEnabled
          >
            <StoryContent story={story} styles={styles} mode="disclosure" />
          </ScrollView>
        ) : null
      ) : null}
    </View>
  );
}

function StoryContent({ story, styles, mode }: {
  story: SessionStoryPresentation;
  styles: ReturnType<typeof makeStyles>;
  mode: 'disclosure' | 'settings';
}) {
  const highlight = story.highlight?.trim() ?? '';
  const narrative = story.narrative?.trim() ?? '';
  const unfoldedContents = story.unfoldedContents.filter((content) => content.trim());
  const settings = mode === 'settings';
  if (settings && !highlight && !narrative && unfoldedContents.length === 0) {
    return <Text testID="session-story-empty" style={styles.settingsEmpty}>아직 정리된 스토리가 없습니다.</Text>;
  }

  const content = (
    <>
      {highlight ? <View style={settings ? styles.settingsSection : styles.section}>
        <Text style={settings ? styles.settingsLabel : styles.label}>하이라이트</Text>
        <Text testID="session-story-copy" style={settings ? styles.settingsCopy : styles.highlight}>{highlight}</Text>
      </View> : null}
      {narrative || unfoldedContents.length ? <View style={settings ? styles.settingsSection : styles.section}>
        <Text style={settings ? styles.settingsLabel : styles.label}>줄거리</Text>
        {narrative ? <Text testID="session-story-copy" style={settings ? styles.settingsCopy : styles.copy}>{narrative}</Text> : null}
        {unfoldedContents.map((content, index) => <Text key={`${index}-${content}`} testID="session-story-copy" style={settings ? styles.settingsCopy : styles.copy}>{content}</Text>)}
      </View> : null}
    </>
  );

  return settings ? (
    <View testID="session-story-settings-content" style={styles.settingsContent}>{content}</View>
  ) : content;
}

export function projectSessionStory(
  response: SessionStoryResponse | null,
  strict: boolean,
  mode: 'disclosure' | 'settings' = 'disclosure',
): SessionStoryPresentation | null {
  if (response === null) {
    return mode === 'settings'
      ? { highlight: null, narrative: null, unfoldedContents: [] }
      : null;
  }

  let highlight: string | null;
  let narrative: string | null;
  if (mode === 'disclosure') {
    if (response.highlight === null || response.narrative === null) return null;
    if (
      typeof response.highlight !== 'string'
      || typeof response.narrative !== 'string'
    ) {
      if (strict) {
        throw new Error('[SessionStoryPanel] highlight/narrative wire shape is invalid');
      }
      return null;
    }
    highlight = response.highlight.trim();
    narrative = response.narrative.trim();
    if (!highlight || !narrative) return null;
  } else {
    const readText = (value: unknown, field: string) => {
      if (value === null) return null;
      if (typeof value === 'string') return value.trim() || null;
      if (strict) throw new Error(`[SessionStoryPanel] ${field} wire shape is invalid`);
      return null;
    };
    highlight = readText(response.highlight, 'highlight');
    narrative = readText(response.narrative, 'narrative');
  }

  const unfoldedContents = Array.isArray(response.unfolded_turn_summaries)
    ? response.unfolded_turn_summaries.flatMap((summary) => {
        const content = typeof summary?.content === 'string' ? summary.content.trim() : '';
        return content ? [content] : [];
      })
    : [];
  return { highlight, narrative, unfoldedContents };
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      backgroundColor: t.colors.surfaceMuted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.borderSubtle,
    },
    header: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: t.foundation.pageInset,
    },
    headerTitle: {
      flex: 1,
      color: t.colors.textSecondary,
      ...t.foundation.typography.meta,
      fontWeight: '600',
    },
    loading: {
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
      paddingBottom: t.spacing.sm,
    },
    scroll: {
      maxHeight: t.foundation.minHeight.memo * 2,
    },
    content: {
      gap: t.spacing.md,
      paddingHorizontal: t.foundation.pageInset,
      paddingBottom: t.spacing.md,
    },
    section: {
      gap: t.spacing.xs,
    },
    label: {
      color: t.colors.textTertiary,
      ...t.foundation.typography.label,
    },
    highlight: {
      color: t.colors.textPrimary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      fontWeight: '600',
    },
    copy: {
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    settingsRoot: { gap: t.spacing.md },
    settingsLoading: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    settingsError: { alignItems: 'flex-start', gap: t.spacing.sm },
    settingsContent: { gap: t.spacing.md },
    settingsSection: { gap: t.spacing.xs },
    settingsLabel: { color: t.colors.textTertiary, ...t.foundation.typography.meta, fontWeight: '600' },
    settingsCopy: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    settingsEmpty: { color: t.colors.textSecondary, ...t.foundation.typography.body },
    settingsRetryText: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '600' },
  });
}
