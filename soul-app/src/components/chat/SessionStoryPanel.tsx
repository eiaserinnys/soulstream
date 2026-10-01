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

interface Props {
  sessionId: string;
  api: Pick<ApiClient, 'getSessionStory'> | null;
  openRequestId?: number | null;
  onOpenRequestHandled?: () => void;
}

interface SessionStoryPresentation {
  highlight: string;
  narrative: string;
  unfoldedContents: string[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'hidden';

export function SessionStoryPanel({
  sessionId,
  api,
  openRequestId = null,
  onOpenRequestHandled,
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
  }, [api, sessionId]);

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const expand = useCallback((forceLoad = false) => {
    setExpanded(true);
    if (!api || (!forceLoad && loadState !== 'idle')) return;

    const generation = ++requestGeneration.current;
    setLoadState('loading');
    void api.getSessionStory(sessionId)
      .then((response) => {
        if (requestGeneration.current !== generation) return;
        const nextStory = projectSessionStory(response, isDevelopmentBuild);
        if (!nextStory) {
          setExpanded(false);
          setLoadState('hidden');
          return;
        }
        setStory(nextStory);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (requestGeneration.current !== generation) return;
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
      });
  }, [api, isDevelopmentBuild, loadState, sessionId]);

  const toggle = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    expand();
  }, [expand, expanded]);

  useEffect(() => {
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
    onOpenRequestHandled,
    openRequestId,
    requestContextChanged,
  ]);

  if (isDevelopmentBuild && developmentFailure) {
    throw developmentFailure;
  }
  if (!api || loadState === 'hidden') return null;

  return (
    <View testID="session-story-panel" style={styles.container}>
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
          <View style={styles.loading}>
            <ActivityIndicator color={t.colors.textTertiary} />
          </View>
        ) : story ? (
          <ScrollView
            testID="session-story-scroll"
            style={styles.scroll}
            contentContainerStyle={styles.content}
            nestedScrollEnabled
          >
            <View style={styles.section}>
              <Text style={styles.label}>하이라이트</Text>
              <Text testID="session-story-copy" style={styles.highlight}>
                {story.highlight}
              </Text>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>줄거리</Text>
              <Text testID="session-story-copy" style={styles.copy}>
                {story.narrative}
              </Text>
              {story.unfoldedContents.map((content, index) => (
                <Text
                  key={`${index}-${content}`}
                  testID="session-story-copy"
                  style={styles.copy}
                >
                  {content}
                </Text>
              ))}
            </View>
          </ScrollView>
        ) : null
      ) : null}
    </View>
  );
}

export function projectSessionStory(
  response: SessionStoryResponse | null,
  strict: boolean,
): SessionStoryPresentation | null {
  if (response === null) return null;
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

  const highlight = response.highlight.trim();
  const narrative = response.narrative.trim();
  if (!highlight || !narrative) return null;

  const unfoldedContents = Array.isArray(response.unfolded_turn_summaries)
    ? response.unfolded_turn_summaries.flatMap((summary) => {
        const content = typeof summary?.content === 'string'
          ? summary.content.trim()
          : '';
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
  });
}
