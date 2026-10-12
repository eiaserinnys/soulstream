import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { renderText, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import { useTokens } from '../../theme';
import { AssistantMessage } from '../events/AssistantMessage';
import { readChatUiPublication, type ChatUiRichPublication } from './chatUiPublication';
import { useChatUiController } from './ChatUiControllerProvider';
import { ChatUiErrorBoundary } from './ChatUiErrorBoundary';
import { ChatUiLinkFocusScope } from './ChatUiLinkFocusScope';
import { ChatUiNodes } from './ChatUiNodes';

type Props = Omit<React.ComponentProps<typeof AssistantMessage>, 'children' | 'textOverride' | 'notice'>;
export function ChatUiMessage(props: Props) {
  const publication = useMemo(() => readChatUiPublication(props.event.data), [props.event.data]);
  if (publication.kind === 'absent') return <AssistantMessage {...props} />;
  if (publication.kind === 'invalid') return <ChatUiLinkFocusScope><AssistantMessage {...props}
    notice={<FallbackNotice text="화면을 표시하지 못했어. 저장된 글로 보여줄게." />} /></ChatUiLinkFocusScope>;
  if (publication.kind === 'unsupported') return <ChatUiLinkFocusScope><AssistantMessage {...props}
    textOverride={renderText(publication.document)} notice={<FallbackNotice text="이 버전에서는 기본값 글로 보여줄게." />} /></ChatUiLinkFocusScope>;
  return <ChatUiLinkFocusScope><ChatUiErrorBoundary key={JSON.stringify([publication.uiId, publication.hash])}
    fallback={<ChatUiRenderFallback {...props} document={publication.document} />}>
    <RichMessage {...props} publication={publication} />
  </ChatUiErrorBoundary></ChatUiLinkFocusScope>;
}
function RichMessage({ publication, ...props }: Props & { publication: ChatUiRichPublication }) {
  const controller = useChatUiController(publication);
  return <AssistantMessage {...props} bubbleWidth="fill"><ChatUiNodes doc={publication.document} controller={controller}
    presentation={props.presentation ?? 'default'} /></AssistantMessage>;
}
function FallbackNotice({ text }: { text: string }) {
  const t = useTokens();
  return <Text testID="chat-ui-fallback-notice" style={{ fontSize: t.chatFontSize.meta,
    lineHeight: t.chatFontSize.meta * t.lineHeightRatio, color: t.colors.textSecondary, marginBottom: t.spacing.sm }}>{text}</Text>;
}

export function ChatUiRenderFallback({ document, ...props }: Props & { document: NormalizedChatUiDocumentV1 }) {
  return <AssistantMessage {...props} textOverride={renderText(document)}
    notice={<FallbackNotice text="화면을 표시하지 못했어. 기본값 글로 보여줄게." />} />;
}
