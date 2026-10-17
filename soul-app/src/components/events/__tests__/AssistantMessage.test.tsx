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
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => 'phone',
  deviceTypeToBaseKey: (type: string) => type === 'phone' ? 'phone' : 'tablet',
}));

import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as ContentLinkHook from '../../../hooks/useOpenContentLink';
import {
  AssistantMessage,
  extractText,
  shouldRenderAsPlainStreamingText,
} from '../AssistantMessage';
import type { Session, SessionEvent } from '../../../api/types';
import { LIGHT_COLORS } from '../../../theme/colors';
import { PHONE_CHAT_TYPOGRAPHY, PHONE_FOUNDATION } from '../../../theme';

const ev = (type: string, data: any): SessionEvent => ({
  id: '1',
  type: type as SessionEvent['type'],
  data,
});

const attachmentDescriptor = (id: string) => ({
  attachment_id: id,
  name: '전체 응답.txt',
  mime_type: 'text/plain',
  byte_size: 2048,
  checksum_sha256: null,
  width: null,
  height: null,
  preview_kind: 'text' as const,
  preview_mime_type: 'text/plain',
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

test('말풍선 폭은 기본 내용 폭을 유지하고 fill에서만 가용 폭을 채운다', () => {
  const event = ev('assistant_message', { text: '짧은 메시지' });
  const screen = render(<AssistantMessage event={event} />);
  const base = StyleSheet.flatten(screen.getByTestId('assistant-message-bubble').props.style);
  expect(base.flexGrow).toBeUndefined();
  screen.rerender(<AssistantMessage event={event} bubbleWidth="content" />);
  expect(StyleSheet.flatten(screen.getByTestId('assistant-message-bubble').props.style)).toEqual(base);
  screen.rerender(<AssistantMessage event={event} bubbleWidth="fill" />);
  expect(StyleSheet.flatten(screen.getByTestId('assistant-message-bubble').props.style)).toEqual({ ...base, flexGrow: 1 });
});

test('attachment-only output keeps horizontal content inset without vertical bubble padding', () => {
  const screen = render(<AssistantMessage attachmentsOnly event={ev('assistant_message', {})}><Text>첨부</Text></AssistantMessage>);
  const style = StyleSheet.flatten(screen.getByTestId('assistant-attachment-content').props.style);
  expect(style.paddingVertical).toBe(0);
  expect(style.paddingHorizontal).toBeGreaterThan(0);
});

test('잘린 assistant 본문은 접미사를 숨기고 기본·원고 모드에서 크기만 표시한다', () => {
  const event = ev('assistant_message', {
    content: '응답 앞부분\n[잘림]',
    attachment_ids: ['assistant-full'],
    truncation: { original_bytes: 2048, attachment: attachmentDescriptor('assistant-full') },
  });

  for (const presentation of ['default', 'manuscript'] as const) {
    const screen = render(<AssistantMessage event={event} presentation={presentation} />);
    const body = screen.getByTestId('assistant-markdown').props.markdown as string;
    expect(body).toContain('응답 앞부분');
    expect(body).not.toContain('[잘림]');
    expect(screen.getByTestId('assistant-truncation-metadata')).toBeTruthy();
    expect(screen.getByText(/잘림 · 전체 2\.0 KB/)).toBeTruthy();
    expect(screen.queryByText('전문 열기')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('assistant-truncation-metadata').props.style)).toMatchObject({
      color: LIGHT_COLORS.textSecondary,
      ...PHONE_FOUNDATION.typography.meta,
    });
  }
});

test('textOverride와 children 경로도 잘림 메타를 본문 뒤에 남긴다', () => {
  const event = ev('assistant_message', {
    content: '저장 본문\n[잘림]',
    truncation: { original_bytes: 1024, attachment: null },
  });

  const overridden = render(
    <AssistantMessage event={event} textOverride={'대체 본문\n[잘림]'} />,
  );
  const overrideBody = overridden.getByTestId('assistant-markdown').props.markdown as string;
  expect(overrideBody).toContain('대체 본문');
  expect(overrideBody).not.toContain('[잘림]');
  expect(overridden.getByTestId('assistant-truncation-metadata')).toBeTruthy();
  expect(overridden.getByText(/잘림 · 전체 1\.0 KB · 전문 보관 실패/)).toBeTruthy();

  const withChildren = render(
    <AssistantMessage event={event}><Text>구조화 본문</Text></AssistantMessage>,
  );
  expect(withChildren.getByText('구조화 본문')).toBeTruthy();
  expect(withChildren.getByTestId('assistant-truncation-metadata')).toBeTruthy();
  expect(withChildren.getByText(/잘림 · 전체 1\.0 KB · 전문 보관 실패/)).toBeTruthy();
});

test('truncation이 없는 assistant 본문은 기존 접미사를 유지하고 메타를 추가하지 않는다', () => {
  const screen = render(<AssistantMessage event={ev('assistant_message', { content: '기존 본문\n[잘림]' })} />);
  expect(screen.getByTestId('assistant-markdown').props.markdown).toContain('[잘림]');
  expect(screen.queryByTestId('assistant-truncation-metadata')).toBeNull();
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

  test('내부 문서 링크는 앱 콘텐츠 링크 핸들러에 전달한다', async () => {
    const openContentLink = jest.fn();
    jest.spyOn(ContentLinkHook, 'useOpenContentLink').mockReturnValue(openContentLink);
    const { getByTestId } = render(
      <AssistantMessage
        event={ev('assistant_message', { content: '[문서](https://soulstream.test/api/markdown-documents/doc-1)' })}
        session={session()}
      />,
    );

    await getByTestId('assistant-markdown').props.onLinkPress({
      url: 'https://soulstream.test/api/markdown-documents/doc-1',
    });
    expect(openContentLink).toHaveBeenCalledWith('https://soulstream.test/api/markdown-documents/doc-1');
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

  test('원고형 진행 안내 assistant 글은 메타 크기와 보조 색을 쓰고 마지막 답은 유지한다', () => {
    const streaming = render(<AssistantMessage presentation="manuscript" narration
      event={ev('text_delta', { text: '두 건을 나눠 맡깁니다.' })} />);
    expect(StyleSheet.flatten(streaming.getByTestId('assistant-streaming-text').props.style)).toMatchObject({
      color: LIGHT_COLORS.textSecondary,
      fontSize: PHONE_CHAT_TYPOGRAPHY.meta,
      lineHeight: PHONE_CHAT_TYPOGRAPHY.meta * 1.6,
    });

    const progress = render(<AssistantMessage presentation="manuscript" narration
      event={ev('assistant_message', { content: '두 건을 나눠 맡깁니다.' })} />);
    const progressStyle = progress.getByTestId('assistant-markdown').props.markdownStyle.paragraph;
    expect(progressStyle).toMatchObject({
      color: LIGHT_COLORS.textSecondary,
      fontSize: PHONE_CHAT_TYPOGRAPHY.meta,
      lineHeight: PHONE_CHAT_TYPOGRAPHY.meta * 1.6,
    });

    const final = render(<AssistantMessage presentation="manuscript"
      event={ev('assistant_message', { content: '확인 결과입니다.' })} />);
    const finalStyle = final.getByTestId('assistant-markdown').props.markdownStyle.paragraph;
    expect(finalStyle.color).toBe(LIGHT_COLORS.textPrimary);
    expect(finalStyle.fontSize).toBe(PHONE_CHAT_TYPOGRAPHY.body);
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


test('structured children inherit the ordinary row inset; timeline callers explicitly opt out', () => {
  const event = ev('assistant_message', { text: '같은 줄' });
  const screen = render(<AssistantMessage event={event} />);
  const row = () => {
    let node = screen.getByTestId('assistant-message-bubble').parent;
    while (node && StyleSheet.flatten(node.props.style)?.marginHorizontal === undefined) node = node.parent;
    return StyleSheet.flatten(node!.props.style);
  };
  const ordinary = row().marginHorizontal;
  expect(ordinary).toBeGreaterThan(0);
  screen.rerender(<AssistantMessage event={event}><Text>구조화 내용</Text></AssistantMessage>);
  expect(row().marginHorizontal).toBe(ordinary);
  screen.rerender(<AssistantMessage event={event} rowInset="none"><Text>타임라인 내용</Text></AssistantMessage>);
  expect(row().marginHorizontal).toBe(0);
});
