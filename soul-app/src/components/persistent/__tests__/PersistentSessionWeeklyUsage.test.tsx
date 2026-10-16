jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { formatUsageUpdatedLabel, type UsageSummaryGauge, type UsageSummaryNode } from '../../../../../packages/soul-ui/src/lib/usage-summary';
import { DESIGN_SPACING } from '../../../theme/tokens';
import { PersistentSessionWeeklyUsage } from '../PersistentSessionWeeklyUsage';

const node = { nodeId: 'node-a', fetchedAt: '2026-10-13T08:00:00.000Z' } as UsageSummaryNode;
const gauges: UsageSummaryGauge[] = [
  { id: 'claude', label: 'Claude', remainingPercent: 73, resetAt: 1_800_352_800 },
  { id: 'fable', label: 'Fable', remainingPercent: 41, resetAt: 1_800_352_800 },
  { id: 'codex', label: 'Codex', remainingPercent: 18, resetAt: 1_800_352_800 },
];
const base = {
  node,
  gauges,
  loading: false,
  loadState: 'ready' as const,
  evaluatedAtMs: 1_800_000_000_000,
  onRetry: jest.fn(),
  onNextNode: jest.fn(),
};

function useTabletDimensions() {
  return jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({
    width: 834, height: 1194, scale: 1, fontScale: 1,
  });
}

test('uses the existing meta text and reduces the visible height with two gauges', () => {
  const dimensions = useTabletDimensions();
  const view = render(<PersistentSessionWeeklyUsage {...base} />);

  expect(view.getByTestId('persistent-session-weekly-usage').props.accessibilityLabel).toBe('주간 남은 사용량');
  expect(view.getByText('Claude')).toBeTruthy();
  expect(view.getAllByText('4일')).toHaveLength(3);
  expect(view.getAllByLabelText('초기화까지 4일 2시간')).toHaveLength(3);
  expect(view.getByText('73%')).toBeTruthy();
  const providerText = StyleSheet.flatten(view.getByText('Claude').props.style);
  expect(providerText.fontSize).toBe(13);
  expect(providerText.lineHeight).toBe(18);
  const slot = StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-slot-0').props.style);
  expect(slot.height).toBe(24);
  expect(slot.gap).toBe(2);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-track-claude').props.style).height).toBe(DESIGN_SPACING.xs);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage').props.style).gap).toBe(16);
  expect(StyleSheet.flatten(view.getByText('18%').props.style).color).toBeTruthy();

  const nodeButton = view.getByLabelText('노드 바꾸기, 현재 node-a');
  const hitFrame = StyleSheet.flatten(nodeButton.props.style);
  expect(nodeButton.props.accessibilityRole).toBe('button');
  expect(hitFrame.height).toBe(48);
  expect(hitFrame.position).toBe('absolute');
  expect(hitFrame.width).toBe('100%');
  expect(hitFrame.top).toBe(-15);
  expect(hitFrame.bottom).toBeUndefined();
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-node-surface').props.style).transform).toBeUndefined();
  const chevron = view.getByTestId('persistent-session-weekly-usage-chevron');
  expect(chevron.props.name).toBe('chevron-forward');
  expect(chevron.props.size).toBe(14);
  expect(StyleSheet.flatten(chevron.props.style).marginRight).toBe(-DESIGN_SPACING.xs);
  fireEvent.press(nodeButton);
  expect(base.onNextNode).toHaveBeenCalledTimes(1);

  view.rerender(<PersistentSessionWeeklyUsage {...base} gauges={gauges.slice(0, 2)} />);
  expect(view.getAllByTestId(/^persistent-session-weekly-usage-slot-/, { includeHiddenElements: true })).toHaveLength(2);
  expect(view.queryByTestId('persistent-session-weekly-usage-slot-2', { includeHiddenElements: true })).toBeNull();
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-node-row').props.style).height).toBe(18);

  view.unmount();
  dimensions.mockRestore();
});

test.each([1, 2, 3, 4])('renders exactly %i gauges without empty slots', count => {
  const four: UsageSummaryGauge[] = [...gauges, { id: 'antigravity', label: 'Antigravity', remainingPercent: 96, resetAt: null }];
  const view = render(<PersistentSessionWeeklyUsage {...base} gauges={four.slice(0, count)} />);
  const slots = view.getAllByTestId(/^persistent-session-weekly-usage-slot-/, { includeHiddenElements: true });
  expect(slots).toHaveLength(count);
  expect(slots.every(slot => !slot.props.accessibilityElementsHidden)).toBe(true);
});

test.each([
  ['loading', true, 'idle', null, '불러오는 중'],
  ['connection error', false, 'connectionError', null, '조회 실패'],
  ['no weekly quota', false, 'ready', node, '주간 한도 없음'],
  ['pending collection', false, 'serverPending', null, '수집 대기'],
] as const)('renders the %s message in one fixed status slot', (_label, loading, loadState, statusNode, message) => {
  const dimensions = useTabletDimensions();
  const onRetry = jest.fn();
  const view = render(<PersistentSessionWeeklyUsage {...base} node={statusNode} gauges={[]} loading={loading} loadState={loadState} onRetry={onRetry} />);

  expect(view.getByText(message)).toBeTruthy();
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-status-slot').props.style).height).toBe(24);
  const statusTrack = StyleSheet.flatten(view.getByTestId('persistent-session-weekly-usage-status-track', {
    includeHiddenElements: true,
  }).props.style);
  expect(statusTrack.height).toBe(DESIGN_SPACING.xs);
  expect(statusTrack.backgroundColor).toBeUndefined();
  expect(view.getAllByTestId(/^persistent-session-weekly-usage-slot-/, { includeHiddenElements: true })).toHaveLength(2);
  const nodeRow = view.getByTestId('persistent-session-weekly-usage-node-row', { includeHiddenElements: true });
  expect(StyleSheet.flatten(nodeRow.props.style).height).toBe(18);
  if (statusNode) {
    expect(view.getByLabelText('노드 바꾸기, 현재 node-a')).toBeTruthy();
  } else {
    expect(nodeRow.props.accessibilityElementsHidden).toBe(true);
  }
  if (loadState === 'connectionError') {
    const retry = view.getByLabelText('주간 사용량 다시 시도');
    const retryFrame = StyleSheet.flatten(retry.props.style);
    expect(retryFrame.position).toBe('absolute');
    expect(retryFrame.top).toBe(-15);
    expect(retryFrame.right).toBe(-17);
    expect(retryFrame.bottom).toBeUndefined();
    expect(retryFrame.minHeight).toBe(48);
    expect(retryFrame.minWidth).toBe(48);
    fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  } else {
    expect(view.queryByLabelText('주간 사용량 다시 시도')).toBeNull();
  }

  view.unmount();
  dimensions.mockRestore();
});

test('keeps stale gauges in place and adds refresh timing to the group description', () => {
  const dimensions = useTabletDimensions();
  const view = render(<PersistentSessionWeeklyUsage {...base} loadState="connectionError" />);

  expect(view.getByTestId('persistent-session-weekly-usage').props.accessibilityLabel)
    .toBe(`주간 남은 사용량, 갱신 지연, ${formatUsageUpdatedLabel(node.fetchedAt, true)}`);
  expect(view.queryByText(/갱신 지연/)).toBeNull();
  expect(view.getAllByTestId(/^persistent-session-weekly-usage-slot-/, { includeHiddenElements: true })).toHaveLength(3);

  view.unmount();
  dimensions.mockRestore();
});
