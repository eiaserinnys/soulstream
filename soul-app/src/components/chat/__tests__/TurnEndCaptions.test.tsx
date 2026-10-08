import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { TurnEndCaptions } from '../TurnEndCaptions';
import type { PersistentInstructionRecordedCaption, TurnSummaryRenderItem } from '../groupChatEvents';
import { DESIGN_SPACING } from '../../../theme';

type TurnUsageMode = 'collapsed' | 'expanded' | 'hidden';
const TurnEndCaptionsWithMode = TurnEndCaptions as unknown as React.ComponentType<
  React.ComponentProps<typeof TurnEndCaptions> & { turnUsageMode?: TurnUsageMode }
>;

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
const instructionRecorded: PersistentInstructionRecordedCaption = {
  instructions: [{
    id: 'instruction-1',
    text: 'Keep decisions in the session note',
    source_turns: ['T195', 'T210'],
  }],
  capReached: true,
};

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

test('applies mode changes to usage without resetting summary expansion or a later manual toggle', () => {
  const view = render(<TurnEndCaptionsWithMode usage={usage} summaries={summaries} turnUsageMode="collapsed" />);
  fireEvent.press(view.getByRole('button', { name: '요약' }));

  view.rerender(<TurnEndCaptionsWithMode usage={usage} summaries={summaries} turnUsageMode="expanded" />);
  expect(view.getByRole('button', { name: usage.title }).props.accessibilityState.expanded).toBe(true);
  expect(view.getByRole('button', { name: '요약' }).props.accessibilityState.expanded).toBe(true);

  fireEvent.press(view.getByRole('button', { name: usage.title }));
  view.rerender(<TurnEndCaptionsWithMode usage={usage} summaries={summaries} turnUsageMode="expanded" />);
  expect(view.getByRole('button', { name: usage.title }).props.accessibilityState.expanded).toBe(false);
  expect(view.getByRole('button', { name: '요약' }).props.accessibilityState.expanded).toBe(true);

  view.rerender(<TurnEndCaptionsWithMode usage={usage} summaries={summaries} turnUsageMode="collapsed" />);
  expect(view.getByRole('button', { name: usage.title }).props.accessibilityState.expanded).toBe(false);
  expect(view.getByRole('button', { name: '요약' }).props.accessibilityState.expanded).toBe(true);
});

test('turn-end heads align to their surface edge and expanded bodies use the small UI gap', () => {
  const view = render(<TurnEndCaptions usage={usage} summaries={summaries} />);
  const titleRow = view.getByRole('button', { name: usage.title })
    .findAllByType(View)
    .find((node) => StyleSheet.flatten(node.props.style).flexDirection === 'row');
  expect(titleRow).toBeDefined();
  expect(StyleSheet.flatten(titleRow?.props.style)).toMatchObject({
    marginRight: 0,
    paddingRight: 0,
  });

  fireEvent.press(view.getByRole('button', { name: usage.title }));
  fireEvent.press(view.getByRole('button', { name: '요약' }));
  expect(StyleSheet.flatten(view.getByTestId('turn-end-captions-bodies').props.style).gap)
    .toBe(DESIGN_SPACING.sm);
});

test('persistent instruction uses the existing independent collapsed head after usage and summary', () => {
  const view = render(
    <TurnEndCaptions
      usage={usage}
      summaries={summaries}
      persistentInstructionRecorded={instructionRecorded}
    />,
  );

  const recordedHead = view.getByRole('button', { name: '📌 지속 지시로 기록했습니다' });
  expect(recordedHead.props.accessibilityState).toEqual({ expanded: false });
  expect(view.queryByText('Keep decisions in the session note (T195, T210)')).toBeNull();

  fireEvent.press(view.getByRole('button', { name: usage.title }));
  fireEvent.press(view.getByRole('button', { name: '요약' }));
  fireEvent.press(recordedHead);

  expect(view.getByText('Keep decisions in the session note (T195, T210)')).toBeTruthy();
  expect(view.getByText('상한(50)에 닿아 더 기록하지 못했습니다')).toBeTruthy();
  const text = textOrder(view);
  expect(text.indexOf(usage.lines[0])).toBeLessThan(text.indexOf('요약 본문'));
  expect(text.indexOf('요약 본문')).toBeLessThan(text.indexOf('Keep decisions in the session note (T195, T210)'));
  expect(text.indexOf('Keep decisions in the session note (T195, T210)'))
    .toBeLessThan(text.indexOf('상한(50)에 닿아 더 기록하지 못했습니다'));
});

test('cap-only event has the dedicated folded title and expands to the cap explanation', () => {
  const view = render(
    <TurnEndCaptions persistentInstructionRecorded={{ instructions: [], capReached: true }} />,
  );

  const recordedHead = view.getByRole('button', { name: '📌 지속 지시 상한에 닿았습니다' });
  expect(recordedHead.props.accessibilityState).toEqual({ expanded: false });
  expect(view.queryByText('상한(50)에 닿아 더 기록하지 못했습니다')).toBeNull();

  fireEvent.press(recordedHead);
  expect(view.getByText('상한(50)에 닿아 더 기록하지 못했습니다')).toBeTruthy();
});
