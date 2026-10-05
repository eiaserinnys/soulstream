import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo } from 'react';
import { Alert, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardMutationResult, CardQuestion } from '../../api/cardTypes';
import { cardOperationId } from '../../hooks/useCardActions';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AttachmentChips } from '../chat/AttachmentChips';
import { ChatComposer } from '../chat/ChatComposer';
import { makeStyles as makeChatStyles } from '../chat/ChatBody.styles';
import { buildAttachmentUri } from '../events/UserMessage';

export interface CardCommentComposerHandle { chooseAnswer(answer: string): void }
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
  sendComment(body: string, onAccepted?: () => void): Promise<boolean>;
  runMutation(mutation: () => Promise<CardMutationResult>, onAccepted?: () => void): Promise<boolean>;
}

export const CardCommentComposer = memo(forwardRef<CardCommentComposerHandle, Props>(function CardCommentComposer({
  api, cardId, sessionId, nodeId, question, cardLoaded, locked, sending, onBusyChange, sendComment, runMutation,
}, ref) {
  const t = useTokens();
  const chatStyles = useMemo(() => makeChatStyles(t), [t]);
  const draft = usePersistentDraft('card-comment', [cardId], '');
  const { value: text, setValue: setText } = draft;
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const mapUploadedPath = React.useCallback((path: string, uploadNode: string) => buildAttachmentUri(serverUrl, uploadNode, path)!, [serverUrl]);
  const attachments = useChatAttachments({ api, sessionId: sessionId ?? undefined, nodeId: nodeId ?? undefined,
    disabled: sending, mapUploadedPath });
  const busy = attachments.uploading || !draft.ready;
  const disabled = locked || busy;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useImperativeHandle(ref, () => ({ chooseAnswer: setText }), [setText]);

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
    const ok = question
      ? await runMutation(() => api.answerCardQuestion(cardId, question.id, body, cardOperationId()), onAccepted)
      : await sendComment(body, onAccepted);
    if (!ok && accepted) {
      setText(current => current && current !== submittedText ? `${submittedText}\n\n${current}` : submittedText);
      attachments.restoreAttachments(submittedAttachments);
    }
  };

  return <View testID="card-comment-composer">
    <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} disabled={disabled}
      styles={chatStyles} textSecondaryColor={t.colors.textSecondary} textMutedColor={t.colors.textMuted} />
    <ChatComposer input={text} onChangeInput={setText} placeholder="커멘트" inputAccessibilityLabel="커멘트" sendAccessibilityLabel="커멘트 보내기"
      onPickAttachment={pickAttachment} onSend={() => { void send(); }} uploading={attachments.uploading} sending={sending}
      disabled={disabled || !api} sendDisabled={!cardLoaded} voiceControls={null} />
  </View>;
}));
