interface WeeklyHeadroom {
  status: "ok" | "stale" | "unavailable";
  headroom: number | null;
  remaining_percent: number | null;
  window_remaining_percent: number | null;
  resets_at: string | null;
  observed_at: string | null;
  quota_label: string | null;
  blocking_quota?: { label: string; resets_at: string | null } | null;
}

export interface ModelPresetAvailability {
  id: string;
  label: string;
  backend: string;
  available: boolean;
  reason: string | null;
  reason_label: string | null;
  resets_at: string | null;
  usage_warning: boolean;
  supported_efforts?: readonly string[];
  default_effort?: string;
  weekly_headroom?: WeeklyHeadroom | null;
}
