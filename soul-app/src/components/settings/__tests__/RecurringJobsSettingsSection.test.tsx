import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { RecurringJobsSettingsSection } from '../RecurringJobsSettingsSection';

const api = {
  listRecurringJobs: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.listRecurringJobs.mockResolvedValue({
    jobs: [{
      job_id: 'job-1',
      name: '음악 추천',
      enabled: true,
      archived_at: null,
      next_run_at: '2026-09-22T00:00:00.000Z',
    }],
  });
});

test('wide settings keeps recurring job management in its own panel', async () => {
  const screen = render(
    <RecurringJobsSettingsSection
      flattened
      serverUrl="https://soul.test"
    />,
  );

  expect(screen.getByTestId('wide-recurring-jobs-panel')).toBeTruthy();
  expect(await screen.findByText('음악 추천')).toBeTruthy();
  expect(screen.getByText('새 작업')).toBeTruthy();
  expect(api.listRecurringJobs).toHaveBeenCalledWith(true);
});
