import React, { forwardRef } from 'react';
import { ChatInputComposer, type ChatInputComposerHandle } from '../chat/ChatInputComposer';
import { useChatUiNoticeLine } from './ChatUiControllerProvider';
import { ChatUiNotice } from './ChatUiNotice';

/** Keep the opened line until the composer submits or this session unmounts. */
export const ChatUiInputComposer = forwardRef<ChatInputComposerHandle,
  React.ComponentProps<typeof ChatInputComposer>>(function ChatUiInputComposer(props, ref) {
  const { noticeLineOpen, closeNoticeLine } = useChatUiNoticeLine();
  return <ChatInputComposer {...props} ref={ref} onMessageSent={closeNoticeLine}
    generatedNotice={noticeLineOpen ? <ChatUiNotice /> : null} />;
});
