import React from 'react';
import { render } from '@testing-library/react-native';

import { ProviderQuotaGrid, quotaResetLabel, type QuotaGridCell } from '../ProviderQuotaGrid';

const cells: (QuotaGridCell | null)[] = [
  null,
  { label: '7일', usedPercent: 58, resetAt: 1_800_000_000, short: false, kind: 'weekly' },
  null,
];

test('an empty window keeps its three-column cell and renders no text or track', () => {
  const screen = render(<ProviderQuotaGrid prefix="provider-quota-codex" cells={cells} />);

  const hidden = { includeHiddenElements: true };
  expect(screen.getByTestId('provider-quota-codex-0', hidden).children).toHaveLength(0);
  expect(screen.getByTestId('provider-quota-codex-1', hidden)).toBeTruthy();
  expect(screen.getByTestId('provider-quota-codex-2', hidden).children).toHaveLength(0);
  expect(screen.queryByTestId('provider-quota-codex-bar-0', hidden)).toBeNull();
  expect(screen.getByTestId('provider-quota-codex-bar-1', hidden)).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-codex-bar-2', hidden)).toBeNull();
});

test('reset labels use a date for monthly windows and name the release clock when exhausted', () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 10, 7, 12, 0));
  const inTwoHours = new Date(2026, 10, 7, 14, 30);
  const inFourDays = new Date(2026, 10, 11, 14, 0);
  const inTwentyDays = new Date(2026, 10, 27, 10, 0);

  expect(quotaResetLabel(inTwoHours.getTime() / 1000, 100, true, 'short')).toBe('14:30 해제');
  expect(quotaResetLabel(inTwoHours.getTime() / 1000, 42, true, 'short')).toBe('3시간 후');
  expect(quotaResetLabel(inFourDays.getTime() / 1000, 100, false, 'weekly')).toBe('14:00 해제');
  expect(quotaResetLabel(inFourDays.getTime() / 1000, 42, false, 'weekly')).toBe('수 14:00');
  expect(quotaResetLabel(inTwentyDays.getTime() / 1000, 100, false, 'monthly')).toBe('11/27 해제');
  expect(quotaResetLabel(inTwentyDays.getTime() / 1000, 42, false, 'monthly')).toBe('11/27');
  jest.useRealTimers();
});

test('epoch seconds and ISO strings both produce the same reset label', () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 10, 7, 12, 0));
  const iso = '2026-11-07T14:30:00';
  const epoch = Math.floor(new Date(iso).getTime() / 1000);

  expect(quotaResetLabel(epoch, 100, true, 'short')).toBe(quotaResetLabel(iso, 100, true, 'short'));
  expect(quotaResetLabel(null, 100, true, 'short')).toBe('—');
  expect(quotaResetLabel('not-a-date', 100, true, 'short')).toBe('—');
  jest.useRealTimers();
});
