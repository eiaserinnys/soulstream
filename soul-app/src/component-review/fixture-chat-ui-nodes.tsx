import React from 'react';
import { ChatUiNodes as ActualNodes } from '../components/chat-ui/ChatUiNodes';

/** Inject a renderer exception inside the real ChatUiMessage error boundary. */
export function ChatUiNodes(props: React.ComponentProps<typeof ActualNodes>) {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('state') === 'render-error') {
    throw Error('공개 검수용 렌더 오류');
  }
  return <ActualNodes {...props} />;
}
