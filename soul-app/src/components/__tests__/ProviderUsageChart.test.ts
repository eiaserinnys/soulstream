import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { ProviderUsageChart, formatResetsAt, quotaAmount } from '../ProviderUsageChart';
import type { ProviderQuota } from '../../api/claudeAuthTypes';

function quota(overrides: Partial<ProviderQuota>): ProviderQuota {
  return {
    id: 'quota',
    label: 'Quota',
    window: '5h',
    unit: 'percent',
    used: null,
    remaining: null,
    limit: null,
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    model: null,
    source: 'test',
    ...overrides,
  };
}

describe('ProviderUsageChart formatters', () => {
  it('formats remaining quota before used quota', () => {
    expect(quotaAmount(quota({ remaining: 3, used: 7, limit: 10 }))).toBe(
      '3 / 10 남음',
    );
  });

  it('formats used quota when remaining is unavailable', () => {
    expect(quotaAmount(quota({ used: 7, limit: 10 }))).toBe('7 / 10 사용');
  });

  it('returns null when reset time or amount cannot be represented', () => {
    expect(formatResetsAt(null)).toBeNull();
    expect(quotaAmount(quota({ used: 7 }))).toBe('7 사용');
  });
});

test('provider labels use readable body typography with Dynamic Type enabled', () => {
  const screen = render(React.createElement(ProviderUsageChart, { usage: {
    generatedAt: '2026-07-20T00:00:00.000Z',
    providers: {
      claude: { status: 'auto', source: 'test', planType: 'max', quotas: [] },
    },
  } as any }));
  const label = screen.getByText('Claude Code');
  expect(StyleSheet.flatten(label.props.style)).toMatchObject({ fontSize: 15, lineHeight: 22 });
  expect(label.props.allowFontScaling).not.toBe(false);
});

test('provider filter composes one provider without changing the default all-provider contract', () => {
  const usage = {
    generatedAt: '2026-07-20T00:00:00.000Z',
    providers: {
      claude: { status: 'auto', source: 'test', planType: 'max', quotas: [] },
      codex: { status: 'auto', source: 'test', planType: 'pro', quotas: [] },
      gemini: {
        status: 'not_configured',
        source: '',
        planType: null,
        quotas: [],
      },
    },
  } as any;
  const all = render(React.createElement(ProviderUsageChart, { usage }));
  expect(all.getByTestId('usage-provider-claude')).toBeTruthy();
  expect(all.getByTestId('usage-provider-codex')).toBeTruthy();

  const codexOnly = render(
    React.createElement(ProviderUsageChart, {
      usage,
      providers: ['codex'],
    }),
  );
  expect(codexOnly.getByTestId('usage-provider-codex')).toBeTruthy();
  expect(codexOnly.queryByTestId('usage-provider-claude')).toBeNull();
});

test('real quota values retain precision while only the visual fill is clamped', () => {
  const screen = render(React.createElement(ProviderUsageChart, { usage: {
    generatedAt: '2026-10-04T00:00:00Z',
    providers: { claude: { status: 'auto', source: 'test', planType: 'max',
      quotas: [quota({ id: 'over', usedPercent: 120.125 }), quota({ id: 'zero', usedPercent: 0 }),
        quota({ id: 'missing', remaining: 3, limit: 10 })] } },
  } as any }));
  expect(screen.getByText('120.125%')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('usage-fill-over').props.style).width).toBe('100%');
  expect(screen.getByText('0%')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('usage-fill-zero').props.style).width).toBe('0%');
  expect(screen.queryByTestId('usage-fill-missing')).toBeNull();
  expect(screen.getAllByText('3 / 10 남음').length).toBeGreaterThan(0);
});
