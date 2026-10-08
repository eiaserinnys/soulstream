import React, { useMemo } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import type { SessionEvent, Session } from '../../api/types';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { createSessionVisualRoles, TABLET_SPACING, useTokens, type DesignTokens } from '../../theme';
import { decodeAuthJwt } from '../../auth/jwt-payload';
import {
  extractMessageCaller,
  pickFallbackChar,
  pickUserAvatarUri,
} from './userAvatarHelpers';
import {
  AttachmentImage,
  ChatRefinedImageGallery,
  getChatAttachmentFilename,
  isChatImageAttachmentPath,
  useChatImageMetadata,
} from '../AttachmentImage';
import { chatImageSource } from '../../lib/chat-image-source';
import { MessageTextSelectionView } from './MessageTextSelectionView';
import type { MessageSelectionModel } from './message-selection-model';
import type { PendingOptimisticStatus } from '../../store/chatStore';
import { extractUserText } from './eventActions';

interface Props {
  messageKind?: React.ReactNode;
  children?: React.ReactNode;
  event: SessionEvent;
  /** 우측 사용자 아바타에 사용할 세션 메타. 없으면 폴백 또는 미표시. */
  session?: Pick<Session, 'nodeId' | 'userName' | 'userPortraitUrl'>;
  /**
   * 'normal'(파란색, 원본 user_message) / 'intervention'(주황색, mid-session 개입).
   * EventRenderer가 event.type에 따라 결정. 빌드 15부터 지원.
   */
  variant?: 'normal' | 'intervention';
  selectionModel?: MessageSelectionModel | null;
  onSelectionDone?: () => void;
  pendingStatus?: PendingOptimisticStatus;
  failureReason?: string;
  onRetry?: () => void;
  onRestore?: () => void;
  presentation?: 'default' | 'manuscript';
}

/**
 * Phase 2 (atom 260513.02 — chat-inline-attachment):
 * 서버는 task_executor.py:165-166, 359-381에서 user_message/intervention_sent
 * 이벤트에 `attachments: string[]`(노드 디스크 절대경로)를 박는다. 클라이언트는
 * 그 path를 `GET /api/attachments/files?nodeId={}&path={}` 라우트로 fetch하여
 * 인라인 표시한다.
 */
export function extractAttachments(event: SessionEvent): string[] {
  const d = event.data as any;
  const arr = d?.attachments;
  if (Array.isArray(arr)) return arr.filter((p) => typeof p === 'string' && p.length > 0);
  return [];
}

/**
 * 첨부 다운로드 라우팅용 nodeId 해소.
 *
 * Session 타입(`api/types.ts`)에 `nodeId?: string`이 있다 (Phase A-bis 2026-05-16
 * camelCase 통일). fallback: event.data.node_id (서버 event payload는 snake_case
 * wire를 그대로 보냄). 둘 다 없으면 undefined — 호출자가 첨부 미표시로 분기.
 */
export function resolveAttachmentNodeId(
  session: Pick<Session, 'nodeId'> | undefined,
  event: SessionEvent,
): string | undefined {
  if (typeof session?.nodeId === 'string' && session.nodeId.length > 0) {
    return session.nodeId;
  }
  const eventNodeId = (event.data as any)?.node_id;
  if (typeof eventNodeId === 'string' && eventNodeId.length > 0) {
    return eventNodeId;
  }
  return undefined;
}

/**
 * 첨부 다운로드 URI 빌더. nodeId 또는 serverUrl이 없으면 null (graceful skip).
 */
export function buildAttachmentUri(
  serverUrl: string | null | undefined,
  nodeId: string | undefined,
  path: string,
): string | null {
  if (!nodeId || !serverUrl) return null;
  return `${serverUrl}/api/attachments/files?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(path)}`;
}

export function UserMessage({
  event,
  session,
  messageKind,
  children,
  variant = 'normal',
  selectionModel,
  onSelectionDone,
  pendingStatus,
  failureReason,
  onRetry,
  onRestore,
  presentation = 'default',
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);
  // caller_info v1 (atom ed3a216d): 본인 JWT의 google picture를 자기 메시지 아바타로
  // 사용. session.userPortraitUrl(노드 소유자 정적 정보)은 fallback. authStore에 파생
  // 필드를 두는 정공법은 본 카드 범위 외(별도 후속 부채). useMemo로 jwt 변할 때만 디코드.
  const profile = useMemo(() => decodeAuthJwt(jwt), [jwt]);
  // 메시지 발신자 신원 — caller가 명시되어 있으면(슬랙·위임 에이전트 등) 본인이
  // 아닌 발신자라는 뜻이며 본인 picture를 덮어 표시하면 안 된다 (결함 4 본질).
  const caller = useMemo(() => extractMessageCaller(event), [event]);

  const content = extractUserText(event);
  const attachments = useMemo(() => extractAttachments(event), [event]);

  // Phase 2: 첨부 다운로드는 *세션의 node_id*로 cross-node 라우팅 (resolveAttachmentNodeId).
  // 둘 다 없으면 첨부 미표시 — graceful (design-principles §8 실패 격리).
  const nodeId = resolveAttachmentNodeId(session, event);
  const attachmentEntries = useMemo(() => attachments.map((path) => ({
    path,
    uri: buildAttachmentUri(serverUrl, nodeId, path),
  })).filter((entry): entry is { path: string; uri: string } => entry.uri !== null), [attachments, nodeId, serverUrl]);
  const attachmentSources = attachmentEntries.map(({ uri }) => ({
    uri,
    ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
  }));
  const manuscriptImageItems = useMemo(() => presentation === 'manuscript'
    ? attachmentEntries.filter(({ path }) => isChatImageAttachmentPath(path)).map(({ uri }) => ({
        source: chatImageSource(uri, serverUrl, jwt),
        filename: getChatAttachmentFilename(uri),
      }))
    : [], [attachmentEntries, jwt, presentation, serverUrl]);
  const manuscriptImagesWithMetadata = useChatImageMetadata(manuscriptImageItems, serverUrl ?? '');
  // 빈 말풍선 방지 — 본문 텍스트와 첨부 둘 다 없으면 렌더 생략.
  if (!content && !children && attachments.length === 0) return null;
  const beforeTextSources = presentation === 'manuscript'
    ? attachmentEntries.filter(({ path }) => !isChatImageAttachmentPath(path)).map(({ uri }) => ({
        uri,
        ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
      }))
    : attachmentSources;

  const bubbleStyle = presentation === 'manuscript'
    ? styles.manuscriptBubble
    : variant === 'intervention' ? styles.bubbleIntervention : styles.bubble;
  const textStyle = presentation === 'manuscript'
    ? styles.manuscriptText
    : variant === 'intervention' ? styles.textIntervention : styles.text;

  // F-11H (2026-05-09, atom F-11): caller_info.source==="system"이면 본인/슬랙/agent
  // 분기와 별도로 *로컬 정적 자산(icon-symbol.png)*을 표시한다. 서버는 caller_info.avatar_url=null로
  // 보내고 클라이언트 측이 자기 자원으로 결정 (design-principles §1 지식 경계).
  // pickUserAvatarUri 자체는 source 모름 (정적 자산을 picker가 결정하면 §1 위반).
  const isSystem = caller?.source === 'system';

  const { uri: avatarUri, useBearer } = pickUserAvatarUri(
    caller,
    profile,
    session?.userPortraitUrl,
    serverUrl,
  );
  const fallbackChar = pickFallbackChar(caller, profile, session?.userName, '나');

  return (
    <View style={presentation === 'manuscript'
      ? styles.manuscriptRow
      : children == null ? styles.row : [styles.row, { marginHorizontal: 0 }]}>
      <View
        testID="user-message-bubble"
        style={[children == null ? bubbleStyle : [bubbleStyle, { backgroundColor: t.colors.accentTint }], pendingStatus === 'sending' && styles.pendingSendingBubble]}
      >
        {messageKind}
        {children}
        {beforeTextSources.length > 0 && (
          <View style={[styles.attachmentList, content ? styles.attachmentListWithText : null,
            ...(presentation === 'manuscript' ? [styles.manuscriptAttachmentList] : [])]}>
            {beforeTextSources.map((source, idx) => <AttachmentImage key={`${idx}-${source.uri}`}
              source={source} sources={beforeTextSources} index={idx} accessibilityLabel={`첨부 이미지 ${idx + 1}`} />)}
          </View>
        )}
        {children == null && content ? (
          selectionModel && onSelectionDone ? (
            <MessageTextSelectionView
              model={selectionModel}
              onDone={onSelectionDone}
              variant={variant === 'intervention' ? 'intervention' : 'user'}
              textStyle={textStyle}
              actionColor={presentation === 'manuscript'
                ? t.colors.textPrimary
                : variant === 'intervention' ? t.colors.interventionText : t.colors.accentText}
            />
          ) : (
            <Text
              testID="user-message-text"
              selectable={false}
              style={textStyle}
            >
              {content}
            </Text>
          )
        ) : null}
        {manuscriptImageItems.length > 0 ? <ChatRefinedImageGallery
          role="user"
          images={manuscriptImagesWithMetadata}
          testID="user-chat-image-gallery"
        /> : null}
        {pendingStatus === 'sending' ? (
          <Text testID="pending-message-status" style={[styles.pendingMeta, textStyle]}>
            보내는 중
          </Text>
        ) : null}
        {pendingStatus === 'failed' ? (
          <View testID="pending-message-failure">
            <Text
              testID="pending-message-failure-reason"
              numberOfLines={1}
              style={presentation === 'manuscript'
                ? [styles.pendingReason, textStyle, { color: t.colors.errorText }]
                : [styles.pendingReason, textStyle]}
            >
              {failureReason ?? '전달을 확인하지 못했습니다'}
            </Text>
            <View style={styles.pendingActions}>
              {onRetry ? (
                <Pressable
                  testID="pending-message-retry"
                  accessibilityRole="button"
                  accessibilityLabel="다시 보내기"
                  style={styles.pendingAction}
                  onPress={onRetry}
                >
                  <Text style={[styles.pendingActionText, { color: presentation === 'manuscript'
                    ? t.colors.textPrimary
                    : variant === 'intervention' ? t.colors.interventionText : t.colors.accentText }]}>
                    다시 보내기
                  </Text>
                </Pressable>
              ) : null}
              {onRestore ? (
                <Pressable
                  testID="pending-message-restore"
                  accessibilityRole="button"
                  accessibilityLabel="입력창으로"
                  style={styles.pendingAction}
                  onPress={onRestore}
                >
                  <Text style={[styles.pendingActionText, { color: presentation === 'manuscript'
                    ? t.colors.textPrimary
                    : variant === 'intervention' ? t.colors.interventionText : t.colors.accentText }]}>
                    입력창으로
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
      {presentation === 'manuscript' ? null : isSystem ? (
        <Image
          source={require('../../../assets/icon-symbol.png')}
          style={styles.avatar}
        />
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
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const AVATAR = t.avatarSize.message;
  const c = t.colors;
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
      marginVertical: sessionRoles.chat.messageGap / 2,
      marginHorizontal: t.spacing.md,
      gap: t.spacing.sm,
    },
    bubble: {
      flexShrink: 1,
      backgroundColor: c.accent,
      borderRadius: t.radius.lg,
      borderBottomRightRadius: 4,
      paddingHorizontal: sessionRoles.chat.bubblePaddingHorizontal,
      paddingVertical: sessionRoles.chat.bubblePaddingVertical,
      maxWidth: sessionRoles.chat.bubbleMaxWidth,
    },
    bubbleIntervention: {
      flexShrink: 1,
      backgroundColor: c.intervention,
      borderRadius: t.radius.lg,
      borderBottomRightRadius: 4,
      paddingHorizontal: sessionRoles.chat.bubblePaddingHorizontal,
      paddingVertical: sessionRoles.chat.bubblePaddingVertical,
      maxWidth: sessionRoles.chat.bubbleMaxWidth,
    },
    text: {
      color: c.accentText,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * t.lineHeightRatio,
    },
    textIntervention: {
      color: c.interventionText,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * t.lineHeightRatio,
    },
    manuscriptRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
      marginLeft: t.spacing.xxxl,
      marginRight: 0,
      marginTop: Math.min(t.spacing.xxxl, TABLET_SPACING.xxl),
      marginBottom: t.spacing.lg,
    },
    manuscriptBubble: {
      flexShrink: 1,
      alignSelf: 'flex-end',
    },
    manuscriptText: {
      color: c.textMuted,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * 1.6,
      textAlign: 'right',
    },
    pendingSendingBubble: {
      opacity: 0.58,
    },
    pendingMeta: {
      marginTop: t.spacing.xs,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      textAlign: 'right',
    },
    pendingReason: {
      marginTop: t.spacing.xs,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      textAlign: 'right',
    },
    pendingActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: t.spacing.md,
      marginTop: t.spacing.xs,
    },
    pendingAction: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    pendingActionText: {
      fontSize: t.chatFontSize.meta,
      fontWeight: '600',
    },
    attachmentList: {
      gap: t.spacing.xs,
    },
    manuscriptAttachmentList: {
      alignItems: 'flex-end',
    },
    // 본문 텍스트가 함께 있을 때만 텍스트와 분리하는 하단 여백.
    attachmentListWithText: {
      marginBottom: t.spacing.sm,
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
  });
}
