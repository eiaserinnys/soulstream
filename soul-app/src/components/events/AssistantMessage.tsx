import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Image, StyleSheet, Platform } from 'react-native';
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
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { AttachmentPreviewModal } from '../AttachmentPreviewModal';
import { formatAttachmentByteSize } from '../AttachmentFileRow';
import { openTruncatedAttachmentPreview } from '../../hooks/useMessageAttachments';
import type { AttachmentView } from '../../lib/attachment-view';
import { stripTruncationSuffix } from '../../lib/event-truncation';

interface Props {
  /** 첨부 전용 출력도 같은 내용 시작선을 쓰되 말풍선과 아바타는 표시하지 않는다. */
  attachmentsOnly?: boolean;
  bubbleWidth?: 'content' | 'fill';
  /** 바깥 줄 여백을 소유한 타임라인만 none을 지정한다. */
  rowInset?: 'default' | 'none';
  messageKind?: React.ReactNode;
  /** 표시 전용 글 대체. 저장 이벤트와 메뉴 연결은 호출자가 소유한다. */
  textOverride?: string;
  notice?: React.ReactNode;
  children?: React.ReactNode;
  event: SessionEvent;
  /** 좌측 에이전트 아바타에 사용할 세션 메타. 없으면 아바타 미표시. */
  session?: Pick<Session, 'agentName' | 'agentPortraitUrl' | 'displayName'>;
  sessionId?: string;
  selectionModel?: MessageSelectionModel | null;
  onSelectionDone?: () => void;
  presentation?: 'default' | 'manuscript';
  narration?: boolean;
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

export function AssistantMessage({
  attachmentsOnly = false,
  event,
  session,
  sessionId,
  bubbleWidth = 'content',
  rowInset = 'default',
  messageKind,
  textOverride,
  notice,
  children,
  selectionModel,
  onSelectionDone,
  presentation = 'default',
  narration = false,
}: Props) {
  const t = useTokens();
  const manuscriptNarration = presentation === 'manuscript' && narration;
  const { styles, markdownStyle, markdownInputStyle } = useMemo(
    () => makeStyles(t, presentation, manuscriptNarration),
    [t, presentation, manuscriptNarration],
  );
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);
  const openContentLink = useOpenContentLink();
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentView | null>(null);

  // 메시지 발신자 신원 — 위임 에이전트가 응답한 경우 caller에 source=agent가 들어온다.
  // assistant 응답은 본인 picture와 무관하므로 profile=null로 호출하여 caller.avatar_url
  // 또는 session.agentPortraitUrl만 사용한다 (UserMessage와 helper 공유, design-principles §10).
  const caller = useMemo(() => extractMessageCaller(event), [event]);

  // 단일 \n을 GFM hard break로 변환 — 라이브러리가 md4cFlags hard-break를
  // JS로 노출하지 않아 컴포넌트 내부 렌더 직전 사전처리로 동등 효과를 낸다.
  // useMemo는 React Hooks rules에 따라 early-return *위*에 배치한다.
  const truncation = event.data.truncation;
  const sourceText = textOverride ?? extractText(event);
  const text = truncation ? stripTruncationSuffix(sourceText) : sourceText;
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
  if (!renderedText && !children && !notice && !truncation) return null;

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
    <View style={presentation === 'manuscript'
      ? styles.manuscriptRow
      : rowInset === 'none' ? [styles.row, { marginHorizontal: 0 }] : styles.row}>
      {presentation === 'manuscript' ? null : attachmentsOnly ? (
        <View style={[styles.avatar, { opacity: 0 }]} />
      ) : avatarUri ? (
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
      <View testID={attachmentsOnly ? 'assistant-attachment-content' : 'assistant-message-bubble'} style={presentation === 'manuscript'
        ? styles.manuscriptBubble
        : attachmentsOnly ? [styles.bubbleLayout, { flexGrow: 1, paddingVertical: 0 }]
          : bubbleWidth === 'fill' ? [styles.bubble, { flexGrow: 1 }] : styles.bubble}>
        {/*
          react-native-enriched-markdown — Software Mansion 제작 Fabric 네이티브 마크다운 렌더러.
          외부 링크는 SFSafariViewController(expo-web-browser.openBrowserAsync)로 통일.
          (빌드 13부터 정본 — 자체 LinkSheet/WebView는 Google OAuth 정책으로 Gmail 차단되어 폐기.)
        */}
        {messageKind}
        {notice}
        {selectionModel && onSelectionDone ? (
          <MessageTextSelectionView
            model={selectionModel}
            onDone={onSelectionDone}
            variant="assistant"
            textStyle={styles.streamingText}
            markdownStyle={markdownInputStyle}
            {...(presentation === 'manuscript' ? { actionColor: t.colors.textPrimary } : {})}
          />
        ) : children ?? (renderAsPlainStreamingText ? (
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
            onLinkPress={({ url }) => { void openContentLink(url); }}
            presentation={presentation}
            serverUrl={serverUrl}
            jwt={jwt}
          />
        ))}
        {truncation ? (
          <Text testID="assistant-truncation-metadata" numberOfLines={1} style={styles.truncationMetadata}>
            {`잘림 · 전체 ${formatAttachmentByteSize(truncation.original_bytes)} · `}
            {truncation.attachment ? (
              <Text
                {...(Platform.OS === 'web' ? { href: '#' } : {})}
                accessibilityRole="link"
                style={{ textDecorationLine: 'underline' }}
                onPress={event => {
                  if (Platform.OS === 'web') event.preventDefault();
                  openTruncatedAttachmentPreview(truncation, sessionId!, setPreviewAttachment);
                }}
              >
                전문 열기
              </Text>
            ) : '전문 보관 실패'}
          </Text>
        ) : null}
        {tokenInfo && !attachmentsOnly ? (
          <Text style={styles.tokenInfo}>{tokenInfo}</Text>
        ) : null}
      </View>
      {previewAttachment ? (
        <AttachmentPreviewModal
          item={previewAttachment}
          items={[previewAttachment]}
          initialIndex={0}
          onClose={() => setPreviewAttachment(null)}
        />
      ) : null}
    </View>
  );
}

function makeStyles(t: DesignTokens, presentation: 'default' | 'manuscript', narration: boolean) {
  const AVATAR = t.avatarSize.message;
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  const sessionRoles = createSessionVisualRoles(t);
  const baseMarkdownStyle = createAssistantMarkdownStyle(t, narration);
  const markdownFontSize = narration ? t.chatFontSize.meta : t.chatFontSize.body;
  const markdownTextColor = narration ? c.textSecondary : c.textPrimary;
  const bubbleLayout = {
    flexShrink: 1,
    paddingHorizontal: sessionRoles.chat.bubblePaddingHorizontal,
    paddingVertical: sessionRoles.chat.bubblePaddingVertical,
    maxWidth: sessionRoles.chat.bubbleMaxWidth,
  };
  return {
    styles: StyleSheet.create({
      row: {
        flexDirection: 'row' as const,
        alignItems: 'flex-start' as const,
        marginVertical: sessionRoles.chat.messageGap / 2,
        marginHorizontal: t.spacing.md,
        gap: t.spacing.sm,
      },
      manuscriptRow: {
        alignSelf: 'stretch',
        marginVertical: sessionRoles.chat.messageGap / 2,
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
      bubbleLayout,
      bubble: {
        ...bubbleLayout,
        ...roles.glassDense.tokenStyle,
        borderBottomLeftRadius: 4,
      },
      tokenInfo: {
        marginTop: t.spacing.xs,
        color: c.textMuted,
        fontSize: t.chatFontSize.meta,
      },
      truncationMetadata: {
        ...sessionRoles.chat.attachment.metadata,
        color: c.textSecondary,
        marginTop: t.spacing.xs,
      },
      streamingText: {
        color: markdownTextColor,
        fontSize: markdownFontSize,
        lineHeight: markdownFontSize * (presentation === 'manuscript' ? 1.6 : t.lineHeightRatio),
      },
      manuscriptBubble: {
        flexShrink: 1,
        alignSelf: 'stretch',
      },
    }),
    markdownStyle: presentation === 'manuscript'
      ? {
          ...baseMarkdownStyle,
          paragraph: { ...baseMarkdownStyle.paragraph, lineHeight: markdownFontSize * 1.6 },
          list: { ...baseMarkdownStyle.list, lineHeight: markdownFontSize * 1.6 },
        }
      : baseMarkdownStyle,
    markdownInputStyle: {
      strong: { color: markdownTextColor },
      em: { color: markdownTextColor },
      link: { color: c.link, underline: true },
      spoiler: {
        color: markdownTextColor,
        backgroundColor: c.surface,
      },
    },
  };
}
