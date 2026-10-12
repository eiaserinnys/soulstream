import React, { forwardRef } from 'react';
import { ChatInputComposer, type ChatInputComposerHandle } from '../chat/ChatInputComposer';
import { useChatUiNotice } from './ChatUiControllerProvider';
import { ChatUiNotice } from './ChatUiNotice';

/** Keep the existing auxiliary row absent when there is no action notice. */
export const ChatUiInputComposer = forwardRef<ChatInputComposerHandle,
  React.ComponentProps<typeof ChatInputComposer>>(function ChatUiInputComposer(props, ref) {
  const notice = useChatUiNotice();
  return <ChatInputComposer {...props} ref={ref} generatedNotice={notice ? <ChatUiNotice /> : null} />;
});
