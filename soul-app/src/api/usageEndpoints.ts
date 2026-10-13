import type { UsageSummarySnapshot } from '../../../packages/soul-ui/src/lib/usage-summary';

import type { ApiRequestContext } from './clientCore';

export function createUsageEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    getUsageSummary: (): Promise<UsageSummarySnapshot> =>
      authFetch(`${base}/api/usage/summary`)
        .then((response) => readJson<UsageSummarySnapshot>(response, 'getUsageSummary')),
  };
}
