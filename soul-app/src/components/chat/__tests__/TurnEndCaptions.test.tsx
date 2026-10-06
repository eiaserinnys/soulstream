import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { TurnEndCaptions } from '../TurnEndCaptions';
import type { TurnSummaryRenderItem } from '../groupChatEvents';

const usage = {
  title: '컨텍스트 약 63.0% · 정가 $0.62',
  expandedTitle: '컨텍스트 약 630,000 / 1,000,000 (63.0%)',
  lines: ['턴 완료 · 입력 645,367 · 출력 6,139 · 정가 $0.62'],
};
const summaries: TurnSummaryRenderItem[] = [{
  kind: 'turn-summary',
  event: { id: '40', type: 'turn_summary', data: { content: '요약 본문' } },
  anchorEventId: 2,
  key: 'turn-summary-40',
  content: '요약 본문',
}];

function textOrder(tree: ReturnType<typeof render>): string[] {
  return tree.getByTestId('turn-end-captions')
    .findAllByType(Text)
    .flatMap((node) => {
      const children = node.props.children;
      return Array.isArray(children) ? children.filter((item) => typeof item === 'string')
        : typeof children === 'string' ? [children] : [];
    });
}

test('starts collapsed, each head toggles only its own body, and expanded bodies stay usage-first', () => {
  const view = render(<TurnEndCaptions usage={usage} summaries={summaries} />);

  const usageHead = view.getByRole('button', { name: usage.title });
  const summaryHead = view.getByRole('button', { name: '요약' });
  expect(usageHead.props.accessibilityState).toEqual({ expanded: false });
  expect(summaryHead.props.accessibilityState).toEqual({ expanded: false });
  expect(view.queryByText('요약 본문')).toBeNull();
  expect(view.queryByText(usage.lines[0])).toBeNull();

  fireEvent.press(summaryHead);
  expect(view.getByText('요약 본문')).toBeTruthy();
  expect(view.queryByText(usage.lines[0])).toBeNull();

  fireEvent.press(summaryHead);
  fireEvent.press(usageHead);
  expect(view.getByText(usage.lines[0])).toBeTruthy();
  expect(view.queryByText('요약 본문')).toBeNull();

  fireEvent.press(summaryHead);
  expect(view.getByText(usage.lines[0])).toBeTruthy();
  const text = textOrder(view);
  expect(text.indexOf(usage.lines[0])).toBeLessThan(text.indexOf('요약 본문'));
});
