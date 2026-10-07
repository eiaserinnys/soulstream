import React, { useMemo } from 'react';
import { View } from 'react-native';
import type { SessionEvent } from '../api/types';
import { EventContextMenu } from '../components/events/EventContextMenu';
import { EventRenderer } from '../components/events/EventRenderer';
import { AgentMessageGroup } from '../components/chat/AgentMessageGroup';
import { useTokens } from '../theme';

const events: SessionEvent[] = [
  {
    id: '950',
    type: 'user_message',
    data: { text: '관련 파일과 현재 구현을 조사해 요약했습니다.', caller_info: { source: 'agent' } },
  },
  {
    id: '951',
    type: 'intervention_sent',
    data: { text: '검수 범위에서 확인할 화면을 준비했습니다.', caller_info: { source: 'agent' } },
  },
  {
    id: '952',
    type: 'user_message',
    data: { text: '같은 대화 안에서 이어진 다른 세션 메시지입니다.', caller_info: { source: 'agent' } },
  },
];

export function ReviewAgentMessageGroup() {
  const t = useTokens();
  const messageRows = useMemo(() => events.map((event) => (
    <EventContextMenu key={event.id} sessionId="review-agent-message" event={event}>
      <EventRenderer event={event} sessionId="review-agent-message" presentation="manuscript" />
    </EventContextMenu>
  )), []);

  return (
    <View testID="review-agent-message-group" style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: t.colors.background }}>
      <AgentMessageGroup count={events.length}>{messageRows}</AgentMessageGroup>
    </View>
  );
}
