jest.mock('../CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: ({ markdown }: any) => require('react').createElement(require('react-native').Text, null, markdown) }));
import React from 'react';
import { render } from '@testing-library/react-native';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';

test('카드 슬롯을 쓰지 않는 채팅은 기존 말풍선·본문·아바타 렌더를 보존한다', () => {
  const session = { agentSessionId: 's1', displayName: '대화', status: 'idle', createdAt: '', updatedAt: '', agentName: '로젤린', userName: '디렉터' };
  const screen = render(<><UserMessage event={{ id: 'u', type: 'user_message', data: { text: '사용자 메시지' } }} session={session} />
    <AssistantMessage event={{ id: 'a', type: 'assistant_message', data: { text: '에이전트 메시지' } }} session={session} /></>);
  expect(screen.toJSON()).toMatchSnapshot();
});
