import React, { useEffect, useMemo } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { SessionEvent, Session } from '../../api/types';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';
import {
  extractMessageCaller,
  pickFallbackChar,
  pickUserAvatarUri,
} from './userAvatarHelpers';
import { normalizeMarkdownBreaks } from './markdownBreaks';
import {
  extractAssistantText,
  formatTokenUsage,
} from './eventActions';
import { MessageTextSelectionView } from './MessageTextSelectionView';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import type { MessageSelectionModel } from './message-selection-model';
import { createAssistantMarkdownStyle } from '../../theme/assistantMarkdownStyle';
import { CopyableAssistantMarkdown } from './CopyableAssistantMarkdown';

interface Props {
  bubbleWidth?: 'content' | 'fill';
  messageKind?: React.ReactNode;
  children?: React.ReactNode;
  event: SessionEvent;
  /** 좌측 에이전트 아바타에 사용할 세션 메타. 없으면 아바타 미표시. */
  session?: Pick<Session, 'agentName' | 'agentPortraitUrl' | 'displayName'>;
  selectionModel?: MessageSelectionModel | null;
  onSelectionDone?: () => void;
}

let loggedStreamingPlainTextFallback = false;

// F-G: extractText를 export하여 단위 테스트 가능. text_start/text_end marker는 payload에
// text/content 필드가 없어 ''를 반환 → 호출자(AssistantMessage)가 null 반환.
// EventRenderer.tsx에서 text_start/text_end → null 명시 처리로 진입점에서 단축한다.
export function extractText(event: SessionEvent): string {
  return extractAssistantText(event);
}

export function shouldRenderAsPlainStreamingText(event: SessionEvent): boolean {
  return event.type === 'text_delta' || (event.data as any)?._live_only === true;
}

function openAssistantLink({ url }: { url: string }) {
  WebBrowser.openBrowserAsync(url).catch((err) => {
    console.warn('[AssistantMessage] openBrowserAsync failed:', err);
  });
}

export function AssistantMessage({
  event,
  session,
  bubbleWidth = 'content',
  messageKind,
  children,
  selectionModel,
  onSelectionDone,
}: Props) {
  const t = useTokens();
  const { styles, markdownStyle, markdownInputStyle } = useMemo(
    () => makeStyles(t),
    [t],
  );
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);

  // 메시지 발신자 신원 — 위임 에이전트가 응답한 경우 caller에 source=agent가 들어온다.
  // assistant 응답은 본인 picture와 무관하므로 profile=null로 호출하여 caller.avatar_url
  // 또는 session.agentPortraitUrl만 사용한다 (UserMessage와 helper 공유, design-principles §10).
  const caller = useMemo(() => extractMessageCaller(event), [event]);

  // 단일 \n을 GFM hard break로 변환 — 라이브러리가 md4cFlags hard-break를
  // JS로 노출하지 않아 컴포넌트 내부 렌더 직전 사전처리로 동등 효과를 낸다.
  // useMemo는 React Hooks rules에 따라 early-return *위*에 배치한다.
  const text = extractText(event);
  const renderedText = useMemo(
    () => normalizeMarkdownBreaks(text),
    [text],
  );
  const tokenInfo = formatTokenUsage((event.data as any)?.usage);
  const renderAsPlainStreamingText = shouldRenderAsPlainStreamingText(event);
  useEffect(() => {
    if (!renderAsPlainStreamingText || loggedStreamingPlainTextFallback) return;
    loggedStreamingPlainTextFallback = true;
    console.info(
      '[AssistantMessage] rendering streaming assistant text with plain Text fallback',
    );
  }, [renderAsPlainStreamingText]);
  if (!renderedText && !children) return null;

  const { uri: avatarUri, useBearer } = pickUserAvatarUri(
    caller,
    null,
    session?.agentPortraitUrl,
    serverUrl,
  );
  const fallbackChar = pickFallbackChar(
    caller,
    null,
    session?.agentName ?? session?.displayName ?? null,
    '·',
  );

  return (
    <View style={children == null ? styles.row : [styles.row, { marginHorizontal: 0 }]}>
      {avatarUri ? (
        <Image
          source={{
            uri: avatarUri,
            ...(useBearer && jwt
              ? { headers: { Authorization: `Bearer ${jwt}` } }
              : {}),
          }}
          style={styles.avatar}
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarFallbackText}>{fallbackChar}</Text>
        </View>
      )}
      <View testID="assistant-message-bubble" style={bubbleWidth === 'fill' ? [styles.bubble, { flexGrow: 1 }] : styles.bubble}>
        {/*
          react-native-enriched-markdown — Software Mansion 제작 Fabric 네이티브 마크다운 렌더러.
          외부 링크는 SFSafariViewController(expo-web-browser.openBrowserAsync)로 통일.
          (빌드 13부터 정본 — 자체 LinkSheet/WebView는 Google OAuth 정책으로 Gmail 차단되어 폐기.)
        */}
        {messageKind}
        {children ?? (selectionModel && onSelectionDone ? (
          <MessageTextSelectionView
            model={selectionModel}
            onDone={onSelectionDone}
            variant="assistant"
            textStyle={styles.streamingText}
            markdownStyle={markdownInputStyle}
          />
        ) : renderAsPlainStreamingText ? (
          <Text
            testID="assistant-streaming-text"
            selectable={false}
            style={styles.streamingText}
          >
            {renderedText}
          </Text>
        ) : (
          <CopyableAssistantMarkdown
            markdown={renderedText}
            markdownStyle={markdownStyle}
            onLinkPress={openAssistantLink}
          />
        ))}
        {tokenInfo ? (
          <Text style={styles.tokenInfo}>{tokenInfo}</Text>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const AVATAR = t.avatarSize.message;
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  const sessionRoles = createSessionVisualRoles(t);
  return {
    styles: StyleSheet.create({
      row: {
        flexDirection: 'row' as const,
        alignItems: 'flex-start' as const,
        marginVertical: sessionRoles.chat.messageGap / 2,
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
      avatarFallback: {
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
      },
      avatarFallbackText: {
        color: c.textMuted,
        fontSize: t.chatFontSize.meta,
        fontWeight: '600' as const,
      },
      bubble: {
        flexShrink: 1,
        ...roles.glassDense.tokenStyle,
        borderBottomLeftRadius: 4,
        paddingHorizontal: sessionRoles.chat.bubblePaddingHorizontal,
        paddingVertical: sessionRoles.chat.bubblePaddingVertical,
        maxWidth: sessionRoles.chat.bubbleMaxWidth,
      },
      tokenInfo: {
        marginTop: t.spacing.xs,
        color: c.textMuted,
        fontSize: t.chatFontSize.meta,
      },
      streamingText: {
        color: c.textPrimary,
        fontSize: t.chatFontSize.body,
        lineHeight: t.chatFontSize.body * t.lineHeightRatio,
      },
    }),
    markdownStyle: createAssistantMarkdownStyle(t),
    markdownInputStyle: {
      strong: { color: c.textPrimary },
      em: { color: c.textPrimary },
      link: { color: c.link, underline: true },
      spoiler: {
        color: c.textPrimary,
        backgroundColor: c.surface,
      },
    },
  };
}
