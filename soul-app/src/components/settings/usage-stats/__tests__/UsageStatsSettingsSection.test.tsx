import React from 'react';
import { createUsageStatsMockFetch, type UsageStatsMockState } from '../../../../test-support/usage-stats-mock-api';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
import { UsageStatsSettingsSection } from '../UsageStatsSettingsSection';
import { UsageShareRow } from '../UsageShareRow';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const originalFetch = global.fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-18T03:00:00.000Z'));
  jest.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue(USAGE_STATS_FIXTURE_ANCHOR);
  global.fetch = jest.fn(createUsageStatsMockFetch('ready', originalFetch));
});
afterEach(() => { jest.restoreAllMocks(); global.fetch = originalFetch; });

test.each(['loading', 'error', 'forbidden'] as const)('%s 응답 상태에서도 기간과 두 필터를 유지한다', async state => {
  const screen = render(<UsageStatsTestHarness initialState={state}><UsageStatsSettingsSection /></UsageStatsTestHarness>);
  if (state === 'error') await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());
  if (state === 'forbidden') await waitFor(() => expect(screen.getByText('이 통계를 볼 권한이 없습니다.')).toBeTruthy());
  expect(screen.getByTestId('usage-stats-controls')).toBeTruthy();
  expect(screen.getByLabelText('모델: 모든 모델')).toBeTruthy();
  expect(screen.getByLabelText('프로젝트: 모든 프로젝트')).toBeTruthy();
});

test('unknown share는 track을 숨기고 실측0 share는 track을 유지한다', () => {
  const screen = render(<UsageShareRow testID="share" label="DeepSeek" value="미기록" color="blue" share={null} />);
  expect(screen.queryByTestId('share-track', { includeHiddenElements: true })).toBeNull();
  screen.rerender(<UsageShareRow testID="share" label="Codex" value="0" color="blue" share={0} />);
  expect(screen.getByTestId('share-track', { includeHiddenElements: true })).toBeTruthy();
});
function UsageStatsTestHarness({ initialState = 'ready', children }: { initialState?: UsageStatsMockState; children: React.ReactNode }) {
  global.fetch = jest.fn(createUsageStatsMockFetch(initialState, originalFetch));
  return <>{children}</>;
}
async function ready(screen: ReturnType<typeof render>) {
  await waitFor(() => expect(screen.getByTestId('usage-stats-total-tokens')).toBeTruthy());
}

function requestUrl(input: unknown): URL {
  return new URL(String(input), 'https://usage-stats.mock');
}

async function chooseView(screen: ReturnType<typeof render>, name: '모델별' | '프로젝트별') {
  fireEvent.press(screen.getByLabelText(/^보기:/));
  fireEvent.press(screen.getByLabelText(name));
}

test('첫 진입은 overview 하나를 받고 날짜 선택만 day 요청을 추가한다', async () => {
  (Date.prototype.toLocaleDateString as jest.Mock).mockReturnValue('2026-10-20');
  const request = jest.spyOn(global, 'fetch');
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);
  expect(request).toHaveBeenCalledTimes(1);
  const initialUrl = requestUrl(request.mock.calls[0][0]);
  expect(initialUrl.pathname).toBe('/api/session-statistics');
  expect(initialUrl.searchParams.get('anchor')).toBe('2026-10-18');

  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(requestUrl(request.mock.calls[1][0]).pathname).toBe('/api/session-statistics/days/2026-10-16');
  await ready(screen);
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-measure-cost'));
  await chooseView(screen, '프로젝트별');
  expect(request).toHaveBeenCalledTimes(2);
});

test('날짜 상세 로딩 중에는 기존 요약과 그래프를 유지하고 선택 날짜 자료만 기다린다', async () => {
  const query = { period: 'week' as const, anchor: '2026-10-18', ...emptyFilter };
  const overview = buildUsageStatsOverview(query);
  const projectRoster = overview.by_project.flatMap(row => row.project_id && row.project_id !== '__other__' ? [row.project_id] : []);
  const detail = buildUsageStatsDayDetail('2026-10-16', emptyFilter, projectRoster);
  const mockFetch = createUsageStatsMockFetch('ready', originalFetch);
  let finishDay!: (value: Response) => void;
  const request = jest.fn((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.includes('/days/')
    ? new Promise<Response>(resolve => { finishDay = resolve; })
    : mockFetch(input, init));
  global.fetch = request;
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);

  expect(request).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await waitFor(() => expect(finishDay).toBeDefined());
  expect(request).toHaveBeenCalledTimes(2);
  expect(requestUrl(request.mock.calls[0][0]).pathname).toBe('/api/session-statistics');
  expect(requestUrl(request.mock.calls[1][0]).pathname).toBe('/api/session-statistics/days/2026-10-16');

  expect(screen.getByTestId('usage-stats-model-chart-chart')).toBeTruthy();
  expect(screen.getByTestId('usage-stats-model-chart-day-2026-10-16').props.accessibilityState)
    .toMatchObject({ selected: true });
  expect(screen.getByLabelText('10월 16일 (금) 선택 해제')).toBeTruthy();
  expect(screen.getByTestId('usage-stats-total-tokens').props.children).toBe('불러오는 중…');
  expect(screen.getByTestId('usage-stats-reference-cost').props.children).toBe('불러오는 중…');
  expect(screen.getByTestId('usage-stats-observed-tokens').props.children).toBe('불러오는 중…');
  expect(within(screen.getByTestId('usage-stats-models')).getByText('불러오는 중…')).toBeTruthy();
  for (const row of overview.by_model) {
    const rowId = row.model !== null
      ? `usage-stats-model-row-${row.provider}-${row.model}`
      : `usage-stats-model-row-${row.provider}-provider`;
    expect(screen.queryByTestId(`${rowId}-value`)).toBeNull();
  }

  await chooseView(screen, '프로젝트별');
  expect(screen.getByTestId('usage-stats-project-chart-day-2026-10-16').props.accessibilityState)
    .toMatchObject({ selected: true });
  expect(within(screen.getByTestId('usage-stats-models')).getByText('불러오는 중…')).toBeTruthy();
  for (const row of overview.by_project) {
    const rowId = `usage-stats-project-row-${row.project_id === null ? '__unclassified__' : row.project_id}`;
    expect(screen.queryByTestId(`${rowId}-value`)).toBeNull();
  }
  expect(request).toHaveBeenCalledTimes(2);

  await chooseView(screen, '모델별');
  await act(async () => {
    finishDay(new Response(JSON.stringify(detail), { headers: { 'Content-Type': 'application/json' } }));
  });
  await waitFor(() => expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(tokenDisplay(detail.totals.metrics.total_tokens, detail.totals.coverage)));
  expect(screen.getByTestId('usage-stats-reference-cost').props.children)
    .toBe(detail.totals.metrics.reference_cost_usd === null
      ? '미확인'
      : `${formatUsageStatsUsd(detail.totals.metrics.reference_cost_usd)}${detail.totals.is_partial ? '+' : ''}`);
  expect(screen.getByTestId('usage-stats-observed-tokens').props.children)
    .toBe(detail.input_material.observed_approximate_tokens === null
      ? '미기록'
      : `추정 약 ${detail.input_material.observed_approximate_tokens.toLocaleString('ko-KR')} 토큰`);
  expect(screen.getByTestId('usage-stats-input-harness').props.children).toBe('관측 안 됨');
  expect(request).toHaveBeenCalledTimes(2);
});

test('KST 오늘에 시작하는 다음 주는 이전 주에서 이동할 수 있다', async () => {
  (Date.now as jest.Mock).mockReturnValue(Date.parse('2026-10-19T00:00:00.000Z'));
  (Date.prototype.toLocaleDateString as jest.Mock).mockReturnValue('2026-10-19');
  const request = jest.spyOn(global, 'fetch');
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);

  fireEvent.press(screen.getByLabelText('이전 기간'));
  await ready(screen);
  expect(screen.getByLabelText('다음 기간').props.accessibilityState?.disabled).toBe(false);
  fireEvent.press(screen.getByLabelText('다음 기간'));
  await ready(screen);
  expect(requestUrl(request.mock.calls.at(-1)?.[0]).searchParams.get('anchor')).toBe('2026-10-19');
});

test('비교 보기 전환은 금요일·정가·요약·입력을 유지하고 추가 조회 없이 그래프와 행만 바꾼다', async () => {
  const screen = render(<UsageStatsTestHarness><UsageStatsSettingsSection /></UsageStatsTestHarness>);
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await ready(screen);
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-measure-cost'));
  const values = [screen.getByTestId('usage-stats-total-tokens').props.children, screen.getByTestId('usage-stats-reference-cost').props.children, screen.getByTestId('usage-stats-observed-tokens').props.children];
  const requests = (global.fetch as jest.Mock).mock.calls.length;
  await chooseView(screen, '프로젝트별');
  expect(screen.queryByTestId('usage-stats-model-chart-chart')).toBeNull();
  expect(screen.getByTestId('usage-stats-project-chart-day-2026-10-16').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByTestId('settings-segment-usage-stats-measure-cost').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByLabelText('10월 16일 (금) 선택 해제')).toBeTruthy();
  expect([screen.getByTestId('usage-stats-total-tokens').props.children, screen.getByTestId('usage-stats-reference-cost').props.children, screen.getByTestId('usage-stats-observed-tokens').props.children]).toEqual(values);
  expect(screen.getByTestId('usage-stats-project-row-project-web-dashboard')).toBeTruthy();
  await chooseView(screen, '모델별');
  expect(screen.getByTestId('usage-stats-model-chart-day-2026-10-16').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.queryByTestId('usage-stats-project-chart-chart')).toBeNull();
  expect((global.fetch as jest.Mock).mock.calls.length).toBe(requests);
});


const emptyFilter = { provider: null, model: null, project_ids: [] as string[] };
const weekQuery = {
  period: 'week' as const,
  anchor: USAGE_STATS_FIXTURE_ANCHOR,
  ...emptyFilter,
};

test('미확인 빈 기간에는 입력 자료 안내를 숨기고 그래프는 미기록으로 둔다', async () => {
  const overview = buildUsageStatsOverview({
    period: 'week',
    anchor: '2026-10-18',
    provider: 'deepseek',
    project_ids: ['folder-infra'],
  });
  overview.series = [];
  overview.totals.metrics.total_tokens = null;
  overview.totals.metrics.reference_cost_usd = null;
  overview.by_model = [];
  overview.by_project = [];
  global.fetch = jest.fn(async () => new Response(JSON.stringify(overview), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);

  expect(screen.getByTestId('usage-stats-total-tokens').props.children).toBe('미기록');
  expect(within(screen.getByTestId('usage-stats-model-chart-chart')).getByText('미기록')).toBeTruthy();
  expect(screen.queryByTestId('settings-section-usage-stats-input')).toBeNull();
  expect(screen.queryByText('막대에서 날짜를 고르세요')).toBeNull();
  expect(screen.queryByTestId('usage-stats-observed-tokens')).toBeNull();
});

test('선택한 금요일의 요약과 입력 구성은 같은 날짜 상세로 바뀐다', async () => {
  const overview = buildUsageStatsOverview(weekQuery);
  const projectRoster = overview.by_project.flatMap(row => row.project_id && row.project_id !== '__other__' ? [row.project_id] : []);
  const detail = buildUsageStatsDayDetail('2026-10-16', emptyFilter, projectRoster);
  const screen = render(
    <UsageStatsTestHarness>
      <UsageStatsSettingsSection />
    </UsageStatsTestHarness>,
  );
  await ready(screen);

  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(tokenDisplay(overview.totals.metrics.total_tokens, overview.totals.coverage));
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await ready(screen);
  expect(screen.getByTestId('usage-stats-total-tokens').props.children)
    .toBe(tokenDisplay(detail.totals.metrics.total_tokens, detail.totals.coverage));
  await chooseView(screen, '프로젝트별');
  expect(screen.getByTestId('usage-stats-project-chart-day-2026-10-16').props.accessibilityState)
    .toMatchObject({ selected: true });
  expect(screen.getByTestId('usage-stats-observed-tokens').props.children)
    .toBe(detail.input_material.observed_approximate_tokens === null
      ? '미기록'
      : `추정 약 ${detail.input_material.observed_approximate_tokens.toLocaleString('ko-KR')} 토큰`);
  if (detail.totals.coverage.missing_usage_turns > 0) {
    expect(screen.getByText(
      `미기록 턴 ${detail.totals.coverage.missing_usage_turns}`,
    )).toBeTruthy();
  } else {
    expect(screen.queryByTestId('usage-stats-missing-turns')).toBeNull();
  }
  expect(screen.getByTestId('usage-stats-input-harness').props.children).toBe('관측 안 됨');
});

test('월 정가 모드는 미확인 Kimi 가격을 표시하고 전체 월 막대는 월간 보기로 연다', async () => {
  const screen = render(
    <UsageStatsTestHarness>
      <UsageStatsSettingsSection />
    </UsageStatsTestHarness>,
  );
  await ready(screen);

  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-month'));
  await ready(screen);
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-measure-cost'));
  const month = buildUsageStatsOverview({ ...weekQuery, period: 'month' });
  const cost = month.totals.metrics.reference_cost_usd;
  expect(screen.getByTestId('usage-stats-reference-cost').props.children)
    .toBe(cost === null
      ? '미확인'
      : `${formatUsageStatsUsd(cost)}${month.totals.is_partial ? '+' : ''}`);
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider-value').props.children)
    .toBe('정가 미확인');

  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-all'));
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-month-2026-10-01'), 'accessibilityTap');
  await ready(screen);
  expect(screen.getByTestId('settings-segment-usage-stats-period-month').props.accessibilityState)
    .toMatchObject({ selected: true });
});

test('기록 없음은 0 요약과 빈 차트를 보이고 프로젝트와 입력 상자는 숨긴다', async () => {
  const screen = render(
    <UsageStatsTestHarness initialState="empty">
      <UsageStatsSettingsSection />
    </UsageStatsTestHarness>,
  );
  await ready(screen);

  expect(screen.getByTestId('usage-stats-total-tokens').props.children).toBe('0');
  expect(screen.getByTestId('usage-stats-reference-cost').props.children).toBe('$0.00');
  expect(screen.getByText('이 기간에 기록이 없습니다')).toBeTruthy();
  expect(screen.queryByText('프로젝트별')).toBeNull();
  expect(screen.queryByText('입력 자료 구성')).toBeNull();
});

test('모델 필터는 해제할 수 있고 실패 상태의 재시도는 데이터를 다시 표시한다', async () => {
  const screen = render(
    <UsageStatsTestHarness initialState="error">
      <UsageStatsSettingsSection />
    </UsageStatsTestHarness>,
  );
  await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());

  expect(screen.getByText('다시 불러오기')).toBeTruthy();
  fireEvent.press(screen.getByText('다시 불러오기'));
  await ready(screen);
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('모델: 모든 모델'));
  fireEvent.press(screen.getByLabelText('Claude'));
  await ready(screen);
  expect(screen.getByLabelText('모델: Claude')).toBeTruthy();
  expect(screen.queryByTestId('usage-stats-model-row-kimi-provider')).toBeNull();

  fireEvent.press(screen.getByLabelText('모델: Claude'));
  fireEvent.press(screen.getByLabelText('모든 모델'));
  await ready(screen);
  expect(screen.getByTestId('usage-stats-model-row-kimi-provider')).toBeTruthy();
});

test('프로젝트 행은 단일 프로젝트 필터를 적용하고 날짜 선택을 푼다', async () => {
  const overview = buildUsageStatsOverview(weekQuery);
  const project = overview.by_project.find(row => row.project_id !== null && row.project_id !== '__other__');
  if (!project?.project_id) throw new Error('fixture에 이름 있는 프로젝트가 없습니다.');
  const screen = render(
    <UsageStatsTestHarness>
      <UsageStatsSettingsSection />
    </UsageStatsTestHarness>,
  );
  await ready(screen);

  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await ready(screen);
  await chooseView(screen, '프로젝트별');
  fireEvent.press(screen.getByTestId(`usage-stats-project-row-${project.project_id}`));
  await ready(screen);

  expect(screen.getByLabelText(`프로젝트: ${project.label}`)).toBeTruthy();
  expect(screen.queryByLabelText('10월 16일 (금) 선택 해제')).toBeNull();
  expect(screen.getByTestId(`usage-stats-project-row-${project.project_id}`)).toBeTruthy();
  expect(screen.queryByTestId('usage-stats-project-row-__other__')).toBeNull();
});

test('프로젝트 선택 목록에 미분류가 있고 선택하면 날짜를 풀고 sentinel query를 보낸다', async () => {
  const request = jest.spyOn(global, 'fetch');
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await ready(screen);

  fireEvent.press(screen.getByLabelText('프로젝트: 모든 프로젝트'));
  fireEvent.press(screen.getByLabelText('미분류'));
  await ready(screen);

  expect(screen.queryByLabelText('10월 16일 (금) 선택 해제')).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
  expect(requestUrl(request.mock.calls[2][0]).searchParams.get('project_ids')).toBe('__unclassified__');
});

test('모델 attribution의 null 행은 모델 미상으로 표시한다', async () => {
  const overview = buildUsageStatsOverview(weekQuery);
  const first = overview.by_model[0];
  overview.by_model = [{ ...first, model: null, attribution: 'model' }];
  global.fetch = jest.fn(async () => new Response(JSON.stringify(overview), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);

  expect(screen.getByText('모델 미상')).toBeTruthy();
});

test('웹 대시보드 프로젝트의 미기록 턴은 요약과 행의 정가 부분합에 반영한다', async () => {
  const screen = render(<UsageStatsTestHarness><UsageStatsSettingsSection /></UsageStatsTestHarness>);
  await ready(screen);
  await chooseView(screen, '프로젝트별');
  fireEvent.press(screen.getByTestId('usage-stats-project-row-project-web-dashboard'));
  await ready(screen);
  expect(screen.getByTestId('usage-stats-reference-cost').props.children).toBe('$13.00+');
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-measure-cost'));
  expect(screen.getByTestId('usage-stats-project-row-project-web-dashboard-value').props.children).toBe('$13.00+');
});

test('화면 진입은 실제 API 요청을 보낸다', async () => {
  const request = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  const screen = render(<UsageStatsSettingsSection />);
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('/api/session-statistics?'), expect.anything()));
  await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());
  request.mockRestore();
});

test('재시도도 실패 응답이면 오류를 유지하고 403은 권한 상태로 표시한다', async () => {
  const request = jest.fn(async () => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
  global.fetch = request;
  const screen = render(<UsageStatsSettingsSection />);
  await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());
  const before = request.mock.calls.length;
  fireEvent.press(screen.getByText('다시 불러오기'));
  await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());
  expect(screen.queryByTestId('usage-stats-total-tokens')).toBeNull();
  request.mockImplementation(async () => new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } }));
  fireEvent.press(screen.getByText('다시 불러오기'));
  await waitFor(() => expect(screen.getByText('이 통계를 볼 권한이 없습니다.')).toBeTruthy());
});

test('날짜 조회 실패는 같은 query와 날짜를 재시도하고 두 요청만 다시 보낸다', async () => {
  const mockFetch = createUsageStatsMockFetch('ready', originalFetch);
  let dayCalls = 0;
  const request = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/days/')) {
      dayCalls += 1;
      if (dayCalls === 1) return Promise.resolve(new Response('{}', { status: 503 }));
    }
    return mockFetch(input, init);
  });
  global.fetch = request;
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await waitFor(() => expect(screen.getByText('다시 불러오기')).toBeTruthy());
  expect(request).toHaveBeenCalledTimes(2);

  fireEvent.press(screen.getByText('다시 불러오기'));
  await ready(screen);
  expect(request).toHaveBeenCalledTimes(4);
  expect(requestUrl(request.mock.calls[2][0]).pathname).toBe('/api/session-statistics');
  expect(requestUrl(request.mock.calls[3][0]).pathname).toBe('/api/session-statistics/days/2026-10-16');
});

test('날짜 조회 403은 현재 query 데이터도 지우고 권한 상태를 보인다', async () => {
  const mockFetch = createUsageStatsMockFetch('ready', originalFetch);
  global.fetch = jest.fn((input, init) => String(input).includes('/days/')
    ? Promise.resolve(new Response('{}', { status: 403 }))
    : mockFetch(input, init));
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await waitFor(() => expect(screen.getByText('이 통계를 볼 권한이 없습니다.')).toBeTruthy());
  expect(screen.queryByTestId('usage-stats-total-tokens')).toBeNull();
  expect(screen.queryByLabelText('10월 16일 (금) 선택 해제')).toBeNull();
});

test('늦은 이전 날짜 응답은 현재 기간을 덮지 않는다', async () => {
  const mockFetch = createUsageStatsMockFetch('ready', originalFetch);
  let finishFriday!: (value: Response) => void;
  global.fetch = jest.fn((input, init) => String(input).includes('/days/2026-10-16')
    ? new Promise<Response>(resolve => { finishFriday = resolve; })
    : mockFetch(input, init));
  const screen = render(<UsageStatsSettingsSection />);
  await ready(screen);
  fireEvent(screen.getByTestId('usage-stats-model-chart-day-2026-10-16'), 'accessibilityTap');
  await waitFor(() => expect(finishFriday).toBeDefined());
  fireEvent.press(screen.getByTestId('settings-segment-usage-stats-period-month'));
  await ready(screen);
  const expected = screen.getByTestId('usage-stats-total-tokens').props.children;
  await act(async () => { finishFriday(new Response(JSON.stringify(buildUsageStatsDayDetail('2026-10-16', emptyFilter)), { headers: { 'Content-Type': 'application/json' } })); });
  expect(screen.getByTestId('usage-stats-total-tokens').props.children).toBe(expected);
  expect(screen.getByTestId('settings-segment-usage-stats-period-month').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.queryByLabelText('10월 16일 (금) 선택 해제')).toBeNull();
});

function tokenDisplay(
  value: number | null,
  coverage: { usage_partial_events: number; missing_usage_turns: number; unknown_total_token_events: number; unattributed_missing_usage: boolean },
): string {
  if (value === null) return '미기록';
  return `${formatUsageStatsTokenCount(value)}${isUsageStatsTokenPartial(coverage) ? '+' : ''}`;
}
