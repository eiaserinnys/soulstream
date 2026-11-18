import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { RecurringJobsList } from '../RecurringJobViews';

const api = { listRecurringJobs: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (createApiClient as jest.Mock).mockReturnValue(api);
});

test('첫 로딩은 섹션 부품을, 새로고침은 행을 밀지 않는 작은 스피너를 세운다', async () => {
  api.listRecurringJobs.mockResolvedValueOnce({
    jobs: [{ job_id: 'job-1', name: '음악 추천', enabled: true, archived_at: null, next_run_at: '2026-09-22T00:00:00.000Z' }],
  });
  const screen = render(<RecurringJobsList serverUrl="https://soul.test" onCreate={jest.fn()} onEdit={jest.fn()} />);
  expect(screen.getByTestId('recurring-jobs-loading')).toBeTruthy();
  expect(await screen.findByText('음악 추천')).toBeTruthy();

  let release: (() => void) | undefined;
  api.listRecurringJobs.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ jobs: [] });
  }));
  fireEvent.press(screen.getByTestId('recurring-jobs-refresh'));
  await waitFor(() => expect(screen.queryByTestId('recurring-jobs-loading')).toBeNull());
  expect(screen.UNSAFE_getAllByType(ActivityIndicator)).toHaveLength(1);
  expect(screen.getByText('음악 추천')).toBeTruthy();
  await act(async () => { release?.(); });
});
