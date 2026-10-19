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
  isUsageStatsTokenPartial,
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
  const projectRoster = overview.by_project.flatMap(row => row.project_id && row.project_id !== '__other__' ? [row.project_id] : []);
  const detail = buildUsageStatsDayDetail('2026-10-16', emptyFilter, projectRoster);
  const screen = render(
    <UsageStatsPreviewProvider>
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(tokenDisplay(overview.totals.metrics.total_tokens, overview.totals.coverage));
  fireEvent.press(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'));
  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(tokenDisplay(detail.totals.metrics.total_tokens, detail.totals.coverage));
  expect(screen.getByTestId('usage-stats-project-chart-day-2026-10-16').props.accessibilityState)
    .toMatchObject({ selected: true });
  expect(screen.getByTestId('usage-stats-observed-chars').props.children)
    .toBe(detail.input_material.observed_chars === null
      ? '미기록'
      : `관측 ${detail.input_material.observed_chars.toLocaleString('ko-KR')}자`);
  if (detail.totals.coverage.missing_usage_turns > 0) {
    expect(screen.getByText(
      `미기록 턴 ${detail.totals.coverage.missing_usage_turns}`,
    )).toBeTruthy();
  } else {
    expect(screen.queryByTestId('usage-stats-missing-turns')).toBeNull();
  }
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
  const cost = month.totals.metrics.reference_cost_usd;
  expect(screen.getByTestId('usage-stats-reference-cost').props.children)
    .toBe(cost === null
      ? '정가 미확인'
      : `${formatUsageStatsUsd(cost)}${month.totals.coverage.unpriced_events > 0 || month.totals.coverage.unknown_total_token_events > 0 ? '+' : ''}`);
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider-value').props.children)
    .toBe('정가 미확인');

  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-all'));
  fireEvent.press(screen.getByTestId('usage-stats-model-chart-month-2026-10-01'));
  expect(screen.getByTestId('settings-segment-usage-stats-period-month').props.accessibilityState)
    .toMatchObject({ selected: true });
});

test('기록 없음은 0 요약과 빈 차트를 보이고 프로젝트와 입력 상자는 숨긴다', () => {
  const screen = render(
    <UsageStatsPreviewProvider initialState="empty">
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  expect(screen.getByTestId('usage-stats-total-tokens').props.children).toBe('0');
  expect(screen.getByTestId('usage-stats-reference-cost').props.children).toBe('$0.00');
  expect(screen.getByText('이 기간에 기록이 없습니다')).toBeTruthy();
  expect(screen.queryByText('프로젝트별')).toBeNull();
  expect(screen.queryByText('입력 자료 구성')).toBeNull();
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

test('프로젝트 행은 단일 프로젝트 필터를 적용하고 날짜 선택을 푼다', () => {
  const overview = buildUsageStatsOverview(weekQuery);
  const project = overview.by_project.find(row => row.project_id !== null && row.project_id !== '__other__');
  if (!project?.project_id) throw new Error('fixture에 이름 있는 프로젝트가 없습니다.');
  const screen = render(
    <UsageStatsPreviewProvider>
      <UsageStatsSettingsSection />
    </UsageStatsPreviewProvider>,
  );

  fireEvent.press(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'));
  fireEvent.press(screen.getByTestId(`usage-stats-project-row-${project.project_id}`));

  expect(screen.getByLabelText(`프로젝트: ${project.label}`)).toBeTruthy();
  expect(screen.queryByLabelText('10월 16일 (금) 선택 해제')).toBeNull();
  expect(screen.getByTestId(`usage-stats-project-row-${project.project_id}`)).toBeTruthy();
  expect(screen.queryByTestId('usage-stats-project-row-__other__')).toBeNull();
});

function tokenDisplay(
  value: number | null,
  coverage: { usage_partial_events: number; missing_usage_turns: number; unknown_total_token_events: number },
): string {
  if (value === null) return '미기록';
  return `${formatUsageStatsTokenCount(value)}${isUsageStatsTokenPartial(coverage) ? '+' : ''}`;
}
