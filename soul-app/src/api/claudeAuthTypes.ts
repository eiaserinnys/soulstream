export type BucketUsage = { utilization: number; resets_at: string };

export type UsageData = {
  five_hour: BucketUsage | null;
  seven_day: BucketUsage | null;
  seven_day_sonnet: BucketUsage | null;
  seven_day_opus: BucketUsage | null;
  seven_day_oauth_apps: BucketUsage | null;
  seven_day_cowork: BucketUsage | null;
  iguana_necktie: BucketUsage | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
};

export type AccountProfile = {
  email: string;
  display_name: string;
  has_claude_max: boolean;
};

export type ProviderName = 'claude' | 'codex' | 'gemini';

export type ProviderQuota = {
  id: string;
  label: string;
  window: string | null;
  unit: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  model: string | null;
  source: string | null;
};

export type ProviderLimits = {
  status: 'auto' | 'not_configured' | 'error';
  source: string;
  planType: string | null;
  quotas: ProviderQuota[];
  error?: string;
};

export type ProviderUsageSnapshot = {
  generatedAt: string;
  providers: Record<ProviderName, ProviderLimits>;
};

// /profile 응답 형태 — orch-server claude_auth.py L152가 result["data"] (Anthropic raw) 그대로 반환,
// 웹 원본 NodeClaudeAuthPanel.tsx L115도 data.account ?? null로 unwrap.
export type ProfileResponse = { account: AccountProfile | null };
