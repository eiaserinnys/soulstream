import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardCheckItem, CardMutationResult, CardQuestion } from '../../api/cardTypes';
import { cardOperationId } from '../../hooks/useCardActions';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AttachmentChips } from '../chat/AttachmentChips';
import { ChatComposer } from '../chat/ChatComposer';
import { makeStyles as makeChatStyles } from '../chat/ChatBody.styles';
import { buildAttachmentUri } from '../events/UserMessage';
import { CompactTouchTarget } from '../CompactTouchTarget';

export interface CardCommentComposerHandle { chooseAnswer(answer: string): void; focus(): void }
interface Props {
  api: ApiClient | null;
  cardId: string;
  sessionId?: string | null;
  nodeId?: string | null;
  question?: CardQuestion;
  cardLoaded: boolean;
  locked: boolean;
  sending: boolean;
  onBusyChange(busy: boolean): void;
  sendComment(body: string, onAccepted?: () => void, itemId?: number): Promise<boolean>;
  runMutation(mutation: () => Promise<CardMutationResult>, onAccepted?: () => void): Promise<boolean>;
  embedded?: boolean;
  targetItem?: Pick<CardCheckItem, 'id' | 'title'> | null;
  onReleaseTarget?(): void;
  onTargetSent?(): void;
  onSent?(): void;
}

export const CardCommentComposer = memo(forwardRef<CardCommentComposerHandle, Props>(function CardCommentComposer({
  api, cardId, sessionId, nodeId, question, cardLoaded, locked, sending, onBusyChange, sendComment, runMutation,
  embedded = false, targetItem, onReleaseTarget, onTargetSent, onSent,
}, ref) {
  const t = useTokens();
  const chatStyles = useMemo(() => makeChatStyles(t), [t]);
  const composerStyles = useMemo(() => makeComposerStyles(t), [t]);
  const draft = usePersistentDraft('card-comment', [cardId], '');
  const { value: text, setValue: setText } = draft;
  const inputRef = useRef<TextInput | null>(null);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const mapUploadedPath = React.useCallback((path: string, uploadNode: string) => buildAttachmentUri(serverUrl, uploadNode, path)!, [serverUrl]);
  const attachments = useChatAttachments({ api, sessionId: sessionId ?? undefined, nodeId: nodeId ?? undefined,
    disabled: sending, mapUploadedPath });
  const busy = attachments.uploading || !draft.ready;
  const disabled = locked || busy;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useImperativeHandle(ref, () => ({ chooseAnswer: setText, focus: () => inputRef.current?.focus() }), [setText]);

  const pickAttachment = () => {
    if (!cardLoaded) return;
    if (sessionId && nodeId) attachments.pickAttachment();
    else Alert.alert('곧 지원', '담당 세션이 연결되면 첨부를 올릴 수 있습니다.');
  };
  const send = async () => {
    if (!api || !cardLoaded || !text.trim() || disabled) return;
    const submittedText = text;
    const submittedAttachments = attachments.attachments;
    const body = [text.trim(), ...submittedAttachments.map(item => `${/\.(png|jpe?g|gif|webp|heic)$/i.test(item.name) ? '!' : ''}[${item.name}](${item.path})`)].join('\n\n');
    let accepted = false;
    const onAccepted = () => {
      accepted = true;
      draft.clear();
      attachments.clearAttachments();
    };
    const ok = targetItem
      ? await sendComment(body, onAccepted, targetItem.id)
      : question
        ? await runMutation(() => api.answerCardQuestion(cardId, question.id, body, cardOperationId()), onAccepted)
        : await sendComment(body, onAccepted);
    if (ok) {
      if (targetItem) onTargetSent?.();
      onSent?.();
    }
    if (!ok && accepted) {
      setText(current => current && current !== submittedText ? `${submittedText}\n\n${current}` : submittedText);
      attachments.restoreAttachments(submittedAttachments);
    }
  };

  return <View testID="card-comment-composer" style={embedded ? composerStyles.embedded : undefined}>
    {targetItem ? <View testID="card-comment-target" style={[composerStyles.target, { backgroundColor: t.colors.warningBg, borderColor: t.colors.warning }]}>
      <Text style={composerStyles.targetText} numberOfLines={1}>대상 {targetItem.id} {targetItem.title}</Text>
      <CompactTouchTarget accessibilityRole="button" accessibilityLabel="대상 해제" onPress={onReleaseTarget}>
        <Text style={composerStyles.releaseText}>해제</Text>
      </CompactTouchTarget>
    </View> : null}
    <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} disabled={disabled}
      styles={chatStyles} textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
    <ChatComposer input={text} onChangeInput={setText} placeholder="커멘트" inputAccessibilityLabel="커멘트" sendAccessibilityLabel="커멘트 보내기"
      onPickAttachment={pickAttachment} onSend={() => { void send(); }} uploading={attachments.uploading} sending={sending}
      disabled={disabled || !api} sendDisabled={!cardLoaded} voiceControls={null} embedded={embedded}
      onInputRef={(input) => { inputRef.current = input; }} />
  </View>;
}));

function makeComposerStyles(t: ReturnType<typeof useTokens>) {
  return StyleSheet.create({
  embedded: { gap: t.uiSpacing.xs },
  target: {
    minHeight: t.hitTarget.min,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: t.foundation.radius.field,
    paddingLeft: t.uiSpacing.sm,
    paddingRight: t.uiSpacing.xxs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.uiSpacing.sm,
  },
  targetText: { flex: 1, minWidth: 0, ...t.foundation.typography.meta, color: t.colors.warningText },
  releaseText: { ...t.foundation.typography.meta, color: t.colors.warningText },
});
}
