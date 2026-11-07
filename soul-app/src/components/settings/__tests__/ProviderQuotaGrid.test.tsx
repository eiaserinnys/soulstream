import React from 'react';
import { render } from '@testing-library/react-native';

import { ProviderQuotaGrid, quotaResetLabel, type QuotaGridCell } from '../ProviderQuotaGrid';

const cells: (QuotaGridCell | null)[] = [
  null,
  { label: '7일', usedPercent: 58, resetAt: 1_800_000_000, short: false },
  null,
];

test('an empty window keeps its three-column cell and track without a bar', () => {
  const screen = render(<ProviderQuotaGrid prefix="provider-quota-codex" cells={cells} />);

  const hidden = { includeHiddenElements: true };
  expect(screen.getByTestId('provider-quota-codex-0', hidden)).toBeTruthy();
  expect(screen.getByTestId('provider-quota-codex-1', hidden)).toBeTruthy();
  expect(screen.getByTestId('provider-quota-codex-2', hidden)).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-codex-bar-0', hidden)).toBeNull();
  expect(screen.getByTestId('provider-quota-codex-bar-1', hidden)).toBeTruthy();
  expect(screen.queryByTestId('provider-quota-codex-bar-2', hidden)).toBeNull();
});

test('a short window that is fully used names the release clock and other windows use the weekday clock', () => {
  const short = quotaResetLabel(1_800_000_000, 100, true);
  const weekly = quotaResetLabel(1_800_000_000, 100, false);

  expect(short).toMatch(/^\d{2}:\d{2} 해제$/);
  expect(weekly).toMatch(/^[일월화수목금토] \d{2}:\d{2}$/);
});

test('epoch seconds and ISO strings both produce the same reset label', () => {
  const iso = '2026-11-07T14:30:00.000Z';
  const epoch = Math.floor(new Date(iso).getTime() / 1000);

  expect(quotaResetLabel(epoch, 100, true)).toBe(quotaResetLabel(iso, 100, true));
  expect(quotaResetLabel(null, 100, true)).toBe('—');
  expect(quotaResetLabel('not-a-date', 100, true)).toBe('—');
});
