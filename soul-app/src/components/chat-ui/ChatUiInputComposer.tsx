import React, { forwardRef } from 'react';
import { ChatInputComposer, type ChatInputComposerHandle } from '../chat/ChatInputComposer';
import { useChatUiNoticeLine } from './ChatUiControllerProvider';
import { ChatUiNotice } from './ChatUiNotice';

/** Close on submit clearing, independently of the API result. */
export const ChatUiInputComposer = forwardRef<ChatInputComposerHandle,
  React.ComponentProps<typeof ChatInputComposer>>(function ChatUiInputComposer(props, ref) {
  const { noticeLineOpen, closeNoticeLine } = useChatUiNoticeLine();
  return <ChatInputComposer {...props} ref={ref} onComposerClearedForSend={closeNoticeLine}
    generatedNotice={noticeLineOpen ? <ChatUiNotice /> : null} />;
});
