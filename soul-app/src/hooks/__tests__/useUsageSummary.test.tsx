import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { UsageSummarySnapshot } from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { ApiClient } from '../../api/client';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUsageSummary } from '../useUsageSummary';

const usage: UsageSummarySnapshot = {
  generatedAt: '2026-10-11T00:00:00.000Z',
  collectedAt: null,
  nodes: [{
    nodeId: 'pas-node',
    fetchedAt: '2026-10-11T00:00:00.000Z',
    stale: false,
    staleSince: null,
    providers: {
      claude: {
        status: 'auto', weeklyRemainingPercent: 73, weeklyResetAt: 1_900_000_000,
        shortRemainingPercent: null, shortResetAt: null, quotas: [],
      },
      codex: null,
      gemini: null,
    },
  }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  useSettingsStore.setState({ serverUrl: 'https://usage.test' });
  useAuthStore.setState({ jwt: 'account-a' });
  resetAuthScopeForTest();
});
afterEach(() => {
  jest.useRealTimers();
  resetAuthScopeForTest();
});

test('opens immediately, pauses closed, reopens, keeps a failed refresh, retries, and clears on auth scope change', async () => {
  const nextScope = deferred<UsageSummarySnapshot>();
  const api = {
    getUsageSummary: jest.fn()
      .mockResolvedValueOnce(usage)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(usage)
      .mockResolvedValueOnce(usage)
      .mockReturnValueOnce(nextScope.promise),
  } as unknown as ApiClient;
  const initial = { enabled: true, nodeId: 'pas-node', api };
  const { result, rerender } = renderHook(
    (props: typeof initial) => useUsageSummary(props),
    { initialProps: initial },
  );

  await waitFor(() => expect(result.current.gauges[0]?.remainingPercent).toBe(73));
  expect(api.getUsageSummary).toHaveBeenCalledTimes(1);

  await act(async () => { await jest.advanceTimersByTimeAsync(15 * 60 * 1000); });
  await waitFor(() => expect(result.current.loadState).toBe('connectionError'));
  expect(result.current.gauges[0]?.remainingPercent).toBe(73);

  await act(async () => result.current.retry());
  await waitFor(() => expect(result.current.loadState).toBe('ready'));
  expect(api.getUsageSummary).toHaveBeenCalledTimes(3);

  rerender({ ...initial, enabled: false });
  await act(async () => { await jest.advanceTimersByTimeAsync(15 * 60 * 1000); });
  expect(api.getUsageSummary).toHaveBeenCalledTimes(3);

  rerender(initial);
  await waitFor(() => expect(result.current.loadState).toBe('ready'));
  expect(api.getUsageSummary).toHaveBeenCalledTimes(4);

  await act(() => useAuthStore.getState().setJwt('account-b'));
  await waitFor(() => expect(result.current.summary).toBeNull());
  await waitFor(() => expect(api.getUsageSummary).toHaveBeenCalledTimes(5));
  await act(async () => nextScope.resolve(usage));
  await waitFor(() => expect(result.current.gauges[0]?.remainingPercent).toBe(73));
});

test('node changes project the all-node response without another request', async () => {
  const api = { getUsageSummary: jest.fn().mockResolvedValue(usage) } as unknown as ApiClient;
  const { result, rerender } = renderHook(
    ({ nodeId }: { nodeId: string | null }) => useUsageSummary({ enabled: true, nodeId, api }),
    { initialProps: { nodeId: 'pas-node' } },
  );
  await waitFor(() => expect(result.current.node?.nodeId).toBe('pas-node'));

  rerender({ nodeId: 'other-node' });
  expect(api.getUsageSummary).toHaveBeenCalledTimes(1);
  expect(result.current.node).toBeNull();
  expect(result.current.loadState).toBe('serverPending');
});
