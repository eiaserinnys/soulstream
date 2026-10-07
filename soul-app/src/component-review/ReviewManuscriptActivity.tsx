import React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useTokens } from '../theme';
import type { SessionEvent } from '../api/types';
import { ToolEvent } from '../components/events/ToolEvent';
import { ThinkingEvent } from '../components/events/ThinkingEvent';
import { TypingIndicator } from '../components/chat/TypingIndicator';
import { ManuscriptActivitySegment } from '../components/chat/ManuscriptActivitySegment';
import type { ManuscriptActivityRenderItem } from '../components/chat/manuscriptActivityProjection';

const events = {
  failedStart: {
    id: 'review-tool-failed',
    type: 'tool_start',
    data: {
      tool_use_id: 'review-tool-failed',
      tool_name: 'mcp__soulstream__Read',
      tool_input: 'src/components/chat/groupChatEvents.ts',
    },
  } as SessionEvent,
  failedResult: {
    id: 'review-tool-failed-result',
    type: 'tool_result',
    data: {
      tool_use_id: 'review-tool-failed',
      result: '파일을 읽었습니다.',
      is_error: true,
    },
  } as SessionEvent,
  thinking: {
    id: 'review-thinking',
    type: 'thinking_delta',
    data: { thinking: '요청과 기존 렌더 동작을 대조했습니다.' },
  } as SessionEvent,
  runningStart: {
    id: 'review-tool-running',
    type: 'tool_start',
    data: {
      tool_use_id: 'review-tool-running',
      tool_name: 'mcp__node__Bash',
      tool_input: 'npm test',
    },
  } as SessionEvent,
  completedStart: {
    id: 'review-tool-completed',
    type: 'tool_start',
    data: {
      tool_use_id: 'review-tool-completed',
      tool_name: 'mcp__soulstream__Read',
      tool_input: 'short example',
    },
  } as SessionEvent,
  completedResult: {
    id: 'review-tool-completed-result',
    type: 'tool_result',
    data: {
      tool_use_id: 'review-tool-completed',
      result: '확인했습니다.',
      is_error: false,
    },
  } as SessionEvent,
};

const manuscriptActivity: ManuscriptActivityRenderItem = {
  kind: 'activity',
  key: 'review-manuscript-activity',
  items: [
    { kind: 'tool', start: events.failedStart, result: events.failedResult, key: 'review-tool-failed' },
    { kind: 'event', event: events.thinking, key: 'review-thinking' },
    { kind: 'tool', start: events.runningStart, key: 'review-tool-running' },
  ],
};

const singleToolActivity: ManuscriptActivityRenderItem = {
  kind: 'activity',
  key: 'review-manuscript-single-activity',
  items: [{
    kind: 'tool',
    start: events.completedStart,
    result: events.completedResult,
    key: 'review-tool-completed',
  }],
};

export function ReviewManuscriptActivity() {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const columnWidth = width >= 768
    ? (width - t.spacing.md * 3) / 2
    : width - t.spacing.md * 2;

  return (
    <ScrollView
      testID="review-manuscript-activity"
      contentContainerStyle={{ padding: t.spacing.md, gap: t.spacing.md }}
    >
      <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>
        도구 활동
      </Text>
      <View style={{ flexDirection: width >= 768 ? 'row' : 'column', gap: t.spacing.md }}>
        <View testID="review-activity-default-column" style={{ width: columnWidth, gap: t.spacing.sm }}>
          <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>기본 채팅</Text>
          <ToolEvent start={events.failedStart} result={events.failedResult} sessionId="review-activity" api={null} />
          <ThinkingEvent event={events.thinking} />
          <ToolEvent start={events.runningStart} sessionId="review-activity" api={null} />
          <TypingIndicator />
        </View>
        <View testID="review-activity-manuscript-column" style={{ width: columnWidth, gap: t.spacing.sm,
          backgroundColor: t.persistentSession.paper }}>
          <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>원고형</Text>
          <ManuscriptActivitySegment item={manuscriptActivity} sessionId="review-activity" api={null} />
          <ManuscriptActivitySegment item={singleToolActivity} sessionId="review-activity" api={null} />
          <ThinkingEvent event={{
            id: 'review-thinking-only',
            type: 'thinking_delta',
            data: { thinking: '도구 없이 이어지는 생각 문단입니다.' },
          }} presentation="manuscript" />
          <TypingIndicator presentation="manuscript" />
        </View>
      </View>
    </ScrollView>
  );
}
