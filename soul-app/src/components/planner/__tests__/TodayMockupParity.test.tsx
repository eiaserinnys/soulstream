jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => 'phone' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../hooks/useCardActions', () => ({
  useCardActions: () => ({ run: jest.fn(), pending: false }),
}));

import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { Session } from '../../../api/types';
import { cardFixture } from '../../../test-support/cards';
import { useSessionStore } from '../../../store/sessionStore';
import { PlannerSectionHeader } from '../PlannerSectionHeader';
import { CardRow } from '../CardRow';

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-30T00:12:00Z'));
  useSessionStore.setState({
    sessions: { 'session-1': {
      agentSessionId: 'session-1', agentId: 'roselin', agentName: '로젤린',
    } as Session },
    catalog: { sessions: {}, folders: [{ id: 'folder-1', name: '🧪 실험' }] as never },
  });
});
afterEach(() => jest.restoreAllMocks());

test('개수는 제목 바로 다음 형제이며 두 글자를 baseline·8pt 간격으로 붙인다', () => {
  const screen = render(<PlannerSectionHeader testID="section" title="확인할 것" count={4} />);
  const title = screen.getByText('확인할 것');
  const count = screen.getByText('4');
  const header = screen.getByTestId('section');
  const children = header.props.children.filter(Boolean);
  expect(children[0].props.children).toBe('확인할 것');
  expect(children[1].props.children).toBe(4);
  expect(StyleSheet.flatten(title.props.style).flex).not.toBe(1);
  expect(StyleSheet.flatten(header.props.style))
    .toMatchObject({ alignItems: 'baseline', gap: 8 });
  expect(StyleSheet.flatten(count.props.style)).toMatchObject({ fontSize: 13 });
});

test('count 미지정 폴더 헤더는 기존 제목·동작 구조와 스타일을 유지한다', () => {
  const screen = render(<PlannerSectionHeader testID="section" title="세션" actionLabel="추가" onAction={jest.fn()} />);
  expect(screen.getByText('추가')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByText('세션').props.style)).toMatchObject({ flex: 1, fontSize: 18 });
  expect(StyleSheet.flatten(screen.getByTestId('section').props.style))
    .toMatchObject({ alignItems: 'center', gap: 12 });
});

test('세션 담당 메타는 폴더 이모지 중복 없이 에이전트 표시명과 상대 시각을 표시한다', () => {
  const card = cardFixture({ assigneeKind: 'session', assigneeAgentId: null, assigneeSessionId: 'session-1' });
  const screen = render(<CardRow today api={null} card={card} onOpen={jest.fn()} />);
  expect(screen.getByText('🧪 실험 · 로젤린 · node-1 · sol')).toBeTruthy();
  expect(screen.getByText('12분 전')).toBeTruthy();
  expect(screen.queryByText(/담당 미지정/)).toBeNull();
});

test('폴더 행은 담당 세션의 에이전트를 표시하고 오늘 행은 앞에 폴더를 표시한다', () => {
  const screen = render(<CardRow api={null} card={cardFixture({ assigneeAgentId: 'seosoyoung', assigneeSessionId: 'session-1' })} onOpen={jest.fn()} />);
  expect(screen.getByText('로젤린 · node-1 · sol')).toBeTruthy();
});
