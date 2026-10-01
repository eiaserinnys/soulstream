jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: (props: any) =>
      React.createElement(
        Text,
        { ...props, testID: 'assistant-markdown' },
        props.markdown,
      ),
  };
});

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return (props: any) => React.createElement(Text, props, props.name);
});

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve()),
}));

import { render } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import {
  AssistantMessage,
  extractText,
  shouldRenderAsPlainStreamingText,
} from '../AssistantMessage';
import type { Session, SessionEvent } from '../../../api/types';

const ev = (type: string, data: any): SessionEvent => ({
  id: '1',
  type: type as SessionEvent['type'],
  data,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  agentSessionId: 'sess-1',
  displayName: '테스트 세션',
  status: 'running',
  createdAt: '2026-05-23T00:00:00Z',
  updatedAt: '2026-05-23T00:00:00Z',
  ...overrides,
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('extractText (F-G)', () => {
  test('text_start payload(빈 marker)는 빈 문자열을 반환한다', () => {
    // engine/types.py:88-114 TextDeltaEngineEvent.to_sse — text_start payload는 {type, timestamp, parent_event_id}만,
    // text/content 필드 없음. historical messages REST에서 분리 반환되면 이 케이스가 발생.
    expect(
      extractText(
        ev('text_start', { type: 'text_start', timestamp: 1.0, parent_event_id: 10 }),
      ),
    ).toBe('');
  });

  test('text_end payload(빈 marker)는 빈 문자열을 반환한다', () => {
    expect(
      extractText(
        ev('text_end', { type: 'text_end', timestamp: 1.0, parent_event_id: 10 }),
      ),
    ).toBe('');
  });

  test('text_delta payload(text 필드)는 text를 반환한다', () => {
    expect(
      extractText(
        ev('text_delta', {
          type: 'text_delta',
          timestamp: 1.0,
          text: 'hello',
          parent_event_id: 10,
        }),
      ),
    ).toBe('hello');
  });

  test('assistant_message content 문자열', () => {
    expect(extractText(ev('assistant_message', { content: 'world' }))).toBe('world');
  });

  test('assistant_message content blocks(배열)에서 text 블록을 join한다', () => {
    expect(
      extractText(
        ev('assistant_message', {
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use' },
            { type: 'text', text: 'b' },
          ],
        }),
      ),
    ).toBe('ab');
  });

  test('delta 필드 fallback', () => {
    // 일부 구버전 SSE 이벤트가 delta 필드를 사용한다 — 회귀 보호.
    expect(extractText(ev('text_delta', { delta: 'partial' }))).toBe('partial');
  });

  test('어떤 필드도 없으면 빈 문자열을 반환한다', () => {
    expect(extractText(ev('system', { foo: 'bar' }))).toBe('');
  });
});

describe('shouldRenderAsPlainStreamingText', () => {
  test('text_delta는 enriched markdown 대신 plain Text로 렌더한다', () => {
    expect(shouldRenderAsPlainStreamingText(ev('text_delta', { text: 'partial' }))).toBe(true);
  });

  test('live-only assistant_message도 plain Text로 렌더한다', () => {
    expect(
      shouldRenderAsPlainStreamingText(
        ev('assistant_message', { content: 'partial', _live_only: true }),
      ),
    ).toBe(true);
  });

  test('최종 assistant_message는 enriched markdown 렌더러로 보낸다', () => {
    expect(shouldRenderAsPlainStreamingText(ev('assistant_message', { content: 'final' }))).toBe(false);
  });
});

describe('AssistantMessage selection entry', () => {
  test('finalized markdown은 평상시에 selectable=false이고 contextMenuItems를 받지 않는다', () => {
    const { getByTestId } = render(
      <AssistantMessage
        event={ev('assistant_message', { content: 'hello' })}
        session={session()}
      />,
    );

    expect(getByTestId('assistant-markdown').props.selectable).toBe(false);
    expect(getByTestId('assistant-markdown').props.contextMenuItems).toBeUndefined();
  });

  test('평상시 markdown 링크는 기존 SFSafariViewController 경로를 유지한다', async () => {
    const { getByTestId } = render(
      <AssistantMessage
        event={ev('assistant_message', { content: '[링크](https://example.com)' })}
        session={session()}
      />,
    );

    await getByTestId('assistant-markdown').props.onLinkPress({
      url: 'https://example.com',
    });
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://example.com');
  });

  test('streaming cumulative text_delta assistant bubble은 native markdown에 넣지 않는다', () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { getByTestId, queryByTestId } = render(
      <AssistantMessage
        event={ev('text_delta', { text: 'streaming...' })}
        session={session()}
      />,
    );

    expect(getByTestId('assistant-streaming-text').props.children).toBe('streaming...');
    expect(getByTestId('assistant-streaming-text').props.selectable).toBe(false);
    expect(queryByTestId('assistant-markdown')).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      '[AssistantMessage] rendering streaming assistant text with plain Text fallback',
    );
  });

  test('live-only streaming assistant bubble도 native markdown에 넣지 않는다', () => {
    const { getByTestId, queryByTestId } = render(
      <AssistantMessage
        event={ev('text_delta', {
          text: 'chunk',
          _live_only: true,
          raw_event_type: 'item/agentMessage/delta',
        })}
        session={session()}
      />,
    );

    expect(getByTestId('assistant-streaming-text').props.children).toBe('chunk');
    expect(queryByTestId('assistant-markdown')).toBeNull();
  });
});
