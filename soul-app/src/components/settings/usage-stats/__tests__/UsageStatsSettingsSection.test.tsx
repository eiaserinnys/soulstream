import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import {
  buildUsageStatsDayDetail,
  buildUsageStatsOverview,
  USAGE_STATS_FIXTURE_ANCHOR,
} from '../../../../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import {
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
} from '../../../../../../packages/soul-ui/src/lib/usage-stats-format';
import {
  UsageStatsPreviewProvider,
  UsageStatsSettingsSection,
} from '../UsageStatsSettingsSection';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const emptyFilter = { provider: null, model: null, project_ids: [] as string[] };
const weekQuery = {
  period: 'week' as const,
  anchor: USAGE_STATS_FIXTURE_ANCHOR,
  ...emptyFilter,
};

test('선택한 금요일의 요약과 입력 구성은 같은 날짜 상세로 바뀐다', () => {
  const overview = buildUsageStatsOverview(weekQuery);
  const detail = buildUsageStatsDayDetail('2026-10-16', emptyFilter);
  const screen = render(
    <UsageStatsPreviewProvider>
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(formatUsageStatsTokenCount(overview.totals.metrics.total_tokens));
  fireEvent.press(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'));
  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(formatUsageStatsTokenCount(detail.totals.metrics.total_tokens));
  expect(screen.getByTestId('usage-stats-observed-chars').props.children)
    .toBe(detail.input_material.observed_chars === null
      ? '미기록'
      : `${detail.input_material.observed_chars.toLocaleString('ko-KR')}자`);
  expect(screen.getByTestId('usage-stats-missing-turns').props.children)
    .toBe(detail.totals.coverage.missing_usage_turns
      ? `미기록 턴 ${detail.totals.coverage.missing_usage_turns}`
      : null);
  expect(screen.getByTestId('usage-stats-input-harness').props.children).toBe('관측 안 됨');
});

test('월 정가 모드는 미확인 Kimi 가격을 표시하고 전체 월 막대는 월간 보기로 연다', () => {
  const screen = render(
    <UsageStatsPreviewProvider>
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-month'));
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-measure-cost'));
  const month = buildUsageStatsOverview({ ...weekQuery, period: 'month' });
  expect(screen.getByTestId('usage-stats-reference-cost').props.children)
    .toBe(formatUsageStatsUsd(month.totals.metrics.reference_cost_usd));
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider-value').props.children)
    .toBe('미확인');

  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-all'));
  fireEvent.press(screen.getByTestId('usage-stats-model-chart-month-2026-10-01'));
  expect(screen.getByTestId('settings-segment-usage-stats-period-month').props.accessibilityState)
    .toMatchObject({ selected: true });
});

test('모델 필터는 해제할 수 있고 실패 상태의 재시도는 데이터를 다시 표시한다', () => {
  const screen = render(
    <UsageStatsPreviewProvider initialState="error">
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  expect(screen.getByText('다시 불러오기')).toBeTruthy();
  fireEvent.press(screen.getByText('다시 불러오기'));
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('모델: 모든 모델'));
  fireEvent.press(screen.getByLabelText('Claude'));
  expect(screen.getByLabelText('모델: Claude')).toBeTruthy();
  expect(screen.queryByTestId('usage-stats-model-row-kimi-provider')).toBeNull();

  fireEvent.press(screen.getByLabelText('모델: Claude'));
  fireEvent.press(screen.getByLabelText('모든 모델'));
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider')).toBeTruthy();
});
