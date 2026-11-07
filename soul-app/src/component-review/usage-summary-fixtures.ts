import type {
  AppUsageSummaryNode,
  AppUsageSummaryProvider,
  AppUsageSummarySnapshot,
} from '../api/usageEndpoints';
import type { UsageSummaryQuota } from '../../../packages/soul-ui/src/lib/usage-summary';

// Public fixture only. Window values and labels mirror what the server sends so
// the shared providerQuotaSlots mapping is exercised without a live node.
const nowSeconds = Math.floor(Date.now() / 1000);

function quota(
  id: string,
  label: string,
  window: string,
  remainingPercent: number,
  resetAt: number,
  model: string | null = null,
): UsageSummaryQuota {
  return { id, label, window, model, remainingPercent, resetAt, purpose: 'execution' };
}

function provider(
  status: AppUsageSummaryProvider['status'],
  quotas: UsageSummaryQuota[] = [],
): AppUsageSummaryProvider {
  return {
    status,
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas,
  };
}

const claudeQuotas = [
  quota('claude:5h', '5시간', '5h', 76, nowSeconds + 3 * 60 * 60),
  quota('claude:7d', '7일', '7d', 87, nowSeconds + 4 * 24 * 60 * 60),
  quota('claude:weekly_scoped:fable', 'Fable', '7d', 82, nowSeconds + 4 * 24 * 60 * 60, 'Fable'),
];

const opencodeGoQuotas = [
  quota('opencode_go:rolling', '5시간', '5h', 98, nowSeconds + 2 * 60 * 60),
  quota('opencode_go:weekly', '7일', '7d', 82, nowSeconds + 4 * 24 * 60 * 60),
  quota('opencode_go:monthly', '월', 'monthly', 91, nowSeconds + 20 * 24 * 60 * 60),
];

const antigravityQuotas = [
  quota('antigravity:gemini:5h', '5시간', '5h', 90, nowSeconds + 3 * 60 * 60),
  quota('antigravity:gemini:weekly', '7일', '7d', 80, nowSeconds + 4 * 24 * 60 * 60),
];

export function reviewUsageSummary(nodeId: string, state: string | null): AppUsageSummarySnapshot {
  const legacy = state === 'legacy' || state === 'legacy-stale';
  const providers: AppUsageSummaryNode['providers'] = {
    claude: provider('auto', claudeQuotas),
    opencode_go: legacy ? provider('not_configured') : provider('auto', opencodeGoQuotas),
    codex: provider('auto', state === 'codex-both'
      ? [quota('codex:5h', '5시간', '5h', 70, nowSeconds + 3 * 60 * 60), quota('codex:7d', '7일', '168h', 58, nowSeconds + 4 * 24 * 60 * 60)]
      : [quota('codex:7d', '7일', '168h', 58, nowSeconds + 4 * 24 * 60 * 60)]),
    antigravity: legacy ? provider('error') : provider('auto', antigravityQuotas),
  };
  const stale = state === 'stale' || state === 'legacy-stale';
  return {
    generatedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    nodes: [{
      nodeId,
      fetchedAt: new Date(stale ? Date.now() - 80 * 60 * 1000 : Date.now() - 60 * 1000).toISOString(),
      stale,
      staleSince: stale ? new Date(Date.now() - 80 * 60 * 1000).toISOString() : null,
      providers,
    }],
  };
}

export function reviewLegacyClaudeProvider(): AppUsageSummaryProvider {
  return provider('auto', claudeQuotas);
}
