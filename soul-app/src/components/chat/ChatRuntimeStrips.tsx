import React, { useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { ClaudeRuntimeTasksStrip } from './ClaudeRuntimeTasksStrip';
import { ClaudeRuntimeSchedulesStrip } from './ClaudeRuntimeSchedulesStrip';
import { ClaudeRuntimeSignalsStrip } from './ClaudeRuntimeSignalsStrip';

// 채팅창 공간을 위해 261103부터 ChatBody에서 렌더하지 않는다(카드 #922). 다시 켤 때는 ChatBody 입력창 바로 위에 되돌린다.
export function ChatRuntimeStrips({ sessionId, api, presentation }: {
  sessionId: string; api: ApiClient | null; presentation: 'default' | 'manuscript';
}) {
  const [visible, setVisible] = useState([false, false, false]);
  const reportVisibility = useMemo(() => [0, 1, 2].map(index => (next: boolean) => {
    setVisible(current => current[index] === next ? current : current.map((value, slot) => slot === index ? next : value));
  }), []);
  // 각 부품의 실제 표시 판정을 재사용한다. 마지막 줄의 경계는 원고 틀이 소유한다.
  const boundary = (index: number) => presentation === 'manuscript' ? {
    onVisibilityChange: reportVisibility[index], separateBelow: visible.slice(index + 1).some(Boolean),
  } : {};
  return <>
    <ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} presentation={presentation} {...boundary(0)} />
    <ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} presentation={presentation} {...boundary(1)} />
    <ClaudeRuntimeSignalsStrip sessionId={sessionId} api={api} presentation={presentation} {...boundary(2)} />
  </>;
}
