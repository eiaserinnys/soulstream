import { DEFAULT_CONFIG } from "./persistent_decision_config.js";

export type DecisionTrigger = "arrival" | "turn_end" | "limit_hit";
export type Provider = "claude" | "codex";
export type DecisionAction =
  | "continue"
  | "new_generation"
  | "schedule_keepalive"
  | "let_cool"
  | "wait_until";

export interface AccountObservation {
  weekly_headroom: number | null;
  weekly_remaining_percent: number | null;
  short_remaining_percent: number | null;
  short_reset_at: string | null;
  observed_at: string | null;
}

export interface DecisionInput {
  trigger: DecisionTrigger;
  now: string;
  context_tokens: number;
  context_estimated: boolean;
  last_call_ended_at: string;
  keepalive_count: number;
  current_preset: string;
  default_model: string;
  fallback_model: string;
  preset_providers: Record<string, Provider>;
  checkpoint_tokens_by_preset: Record<string, number | undefined>;
  accounts: Partial<Record<Provider, AccountObservation>>;
  limit_reset_at?: string;
}

export interface PresetDecisionConfig {
  read_mult: number;
  write_mult: number;
  cache_ttl_seconds: number;
  checkpoint_default_tokens: number;
}

export interface PersistentDecisionConfig {
  presets: Record<string, PresetDecisionConfig>;
  provider_defaults: Record<Provider, PresetDecisionConfig>;
  budget_tokens: number;
  cold_ratio: number;
  keepalive_margin_seconds: number;
  keepalive_short_floor: number;
  keepalive_weekly_floor: number;
  generation_short_floor: number;
  headroom_gap: number;
  usage_stale_seconds: number;
  usage_refresh_seconds: number;
}

export interface DecisionResult {
  action: DecisionAction;
  target_preset?: string;
  wake_at?: string;
  rule: string;
  reason: string;
  inputs_snapshot: Record<string, unknown>;
}

type CheckpointSource = "measured" | "default";

interface DecisionContext {
  input: DecisionInput;
  config: PersistentDecisionConfig;
  presetConfig: PresetDecisionConfig;
  idleSeconds: number;
  checkpointTokens: number;
  checkpointSource: CheckpointSource;
}

interface PresetSelection {
  targetPreset: string;
  rule: string;
}

export function decidePersistentGeneration(
  input: DecisionInput,
  config: PersistentDecisionConfig = DEFAULT_CONFIG,
): DecisionResult {
  const context = createDecisionContext(input, config);

  if (input.trigger === "arrival") {
    if (context.idleSeconds > context.presetConfig.cache_ttl_seconds) {
      const coldThreshold = config.cold_ratio * context.checkpointTokens;
      if (input.context_tokens > coldThreshold) {
        return newGenerationResult(
          context,
          "arrival.cold.over_ratio",
          "유휴 시간이 캐시 수명을 넘고 문맥이 체크포인트 비용 기준을 넘어 새 세대를 엽니다.",
          config,
          { cold_threshold_tokens: coldThreshold },
        );
      }
      return createResult(
        context,
        "continue",
        "arrival.cold.within_ratio",
        "캐시가 식었지만 문맥이 체크포인트 기준 안에 있어 현재 세대를 이어갑니다.",
      );
    }

    if (input.context_tokens > config.budget_tokens) {
      return newGenerationResult(
        context,
        "arrival.warm.over_budget",
        "문맥이 예산을 넘어 새 세대를 엽니다.",
        config,
      );
    }
    return createResult(
      context,
      "continue",
      "arrival.warm.within_budget",
      "캐시가 따뜻하고 문맥이 예산 안에 있어 현재 세대를 이어갑니다.",
    );
  }

  if (input.trigger === "turn_end") {
    if (input.context_tokens > config.budget_tokens) {
      return createResult(
        context,
        "let_cool",
        "turn_end.over_budget",
        "문맥이 예산을 넘었으므로 세대를 식히고 다음 입력에서 다시 판단합니다.",
      );
    }

    const currentAccount = accountForPreset(input, input.current_preset);
    if (!meetsShortFloorOrHasNoShortWindow(
      input,
      currentAccount,
      config.keepalive_short_floor,
      config,
    )) {
      return createResult(
        context,
        "let_cool",
        "turn_end.short_floor",
        "5시간 사용 여유가 낮거나 관측이 오래되어 캐시 유지 호출을 멈춥니다.",
      );
    }

    if (
      isStaleForValue(input, currentAccount, currentAccount?.weekly_headroom, config)
      || currentAccount!.weekly_headroom! < config.keepalive_weekly_floor
    ) {
      return createResult(
        context,
        "let_cool",
        "turn_end.weekly_floor",
        "7일 여유가 낮거나 유효한 관측값이 없어 캐시 유지 호출을 멈춥니다.",
      );
    }

    if (input.context_tokens <= 0) {
      return createResult(
        context,
        "let_cool",
        "turn_end.no_context",
        "문맥 토큰이 0 이하이므로 유지 호출 상한을 계산하지 않고 멈춥니다.",
      );
    }

    const cap = Math.floor(
      (context.presetConfig.write_mult * context.checkpointTokens)
      / (context.presetConfig.read_mult * input.context_tokens),
    ) - 1;
    if (input.keepalive_count >= cap) {
      return createResult(
        context,
        "let_cool",
        "turn_end.cap_reached",
        "캐시 유지 호출 상한에 도달해 더 이상 예약하지 않습니다.",
        { cap },
      );
    }

    const wakeAt = new Date(
      Date.parse(input.last_call_ended_at)
        + (context.presetConfig.cache_ttl_seconds - config.keepalive_margin_seconds) * 1_000,
    ).toISOString();
    return createResult(
      context,
      "schedule_keepalive",
      "turn_end.keepalive",
      "계정 여유와 유지 횟수 상한 안에 있어 캐시 유지 호출을 예약합니다.",
      { cap },
      undefined,
      wakeAt,
    );
  }

  const currentProvider = input.preset_providers[input.current_preset];
  // limit_hit.switch requires a fresh other-provider observation with at least
  // generation_short_floor remaining in the short window and positive 7-day quota.
  const eligibleCandidates = uniquePresets(input.default_model, input.fallback_model)
    .filter((preset) =>
      preset !== input.current_preset
      && input.preset_providers[preset] !== currentProvider,
    )
    .filter((preset) => {
      const account = accountForPreset(input, preset);
      return meetsShortFloorOrHasNoShortWindow(
        input,
        account,
        config.generation_short_floor,
        config,
      )
        && !isStaleForValue(input, account, account?.weekly_remaining_percent, config)
        && account!.weekly_remaining_percent! > 0;
    });

  if (eligibleCandidates.length > 0) {
    const selection = selectPreset(input, config, eligibleCandidates);
    return createResult(
      context,
      "new_generation",
      "limit_hit.switch",
      "현재 계정 한도에 도달해 여유가 있는 다른 계정으로 새 세대를 엽니다.",
      { preset_rule: selection.rule },
      selection.targetPreset,
    );
  }

  return createResult(
    context,
    "wait_until",
    "limit_hit.wait",
    "사용 가능한 대체 계정이 없어 기존 한도 대기 경로를 따릅니다.",
    {},
    undefined,
    input.limit_reset_at,
  );
}

function createDecisionContext(
  input: DecisionInput,
  config: PersistentDecisionConfig,
): DecisionContext {
  const presetConfig = presetConfigFor(input, config, input.current_preset);
  const measuredCheckpoint = input.checkpoint_tokens_by_preset[input.current_preset];
  return {
    input,
    config,
    presetConfig,
    idleSeconds:
      (Date.parse(input.now) - Date.parse(input.last_call_ended_at)) / 1_000,
    checkpointTokens: measuredCheckpoint ?? presetConfig.checkpoint_default_tokens,
    checkpointSource: measuredCheckpoint === undefined ? "default" : "measured",
  };
}

function createResult(
  context: DecisionContext,
  action: DecisionAction,
  rule: string,
  reason: string,
  snapshotExtras: Record<string, unknown> = {},
  targetPreset?: string,
  wakeAt?: string,
): DecisionResult {
  return {
    action,
    ...(targetPreset !== undefined ? { target_preset: targetPreset } : {}),
    ...(wakeAt !== undefined ? { wake_at: wakeAt } : {}),
    rule,
    reason,
    inputs_snapshot: {
      ...copyInput(context.input),
      idle_seconds: context.idleSeconds,
      checkpoint_tokens: context.checkpointTokens,
      checkpoint_source: context.checkpointSource,
      cache_ttl_seconds: context.presetConfig.cache_ttl_seconds,
      budget_tokens: context.config.budget_tokens,
      ...snapshotExtras,
    },
  };
}

function newGenerationResult(
  context: DecisionContext,
  rule: string,
  reason: string,
  config: PersistentDecisionConfig,
  snapshotExtras: Record<string, unknown> = {},
): DecisionResult {
  const selection = selectPreset(context.input, config);
  return createResult(
    context,
    "new_generation",
    rule,
    reason,
    { ...snapshotExtras, preset_rule: selection.rule },
    selection.targetPreset,
  );
}

function selectPreset(
  input: DecisionInput,
  config: PersistentDecisionConfig,
  candidatePresets: string[] = uniquePresets(input.default_model, input.fallback_model),
): PresetSelection {
  const afterShortFloor = candidatePresets.filter((preset) => {
    const account = accountForPreset(input, preset);
    return isStaleForValue(input, account, account?.short_remaining_percent, config)
      || meetsShortFloorOrHasNoShortWindow(
        input,
        account,
        config.generation_short_floor,
        config,
      );
  });

  if (afterShortFloor.length === 0) {
    return { targetPreset: input.current_preset, rule: "preset.short_floor_all" };
  }

  if (
    afterShortFloor.length === 2
    && afterShortFloor.some((preset) => {
      const account = accountForPreset(input, preset);
      return (
        !hasFreshObservationWithoutShortWindow(input, account, config)
        && isStaleForValue(input, account, account?.short_remaining_percent, config)
      )
        || isStaleForValue(input, account, account?.weekly_headroom, config);
    })
  ) {
    return { targetPreset: input.current_preset, rule: "preset.stale_keep_current" };
  }

  const afterWeeklyFloor = afterShortFloor.filter((preset) => {
    const account = accountForPreset(input, preset);
    return isStaleForValue(input, account, account?.weekly_remaining_percent, config)
      || account!.weekly_remaining_percent! > 0;
  });

  if (afterWeeklyFloor.length === 0) {
    return { targetPreset: input.current_preset, rule: "preset.weekly_floor_all" };
  }

  if (afterWeeklyFloor.length === 1) {
    return { targetPreset: afterWeeklyFloor[0]!, rule: "preset.single" };
  }

  const defaultAccount = accountForPreset(input, input.default_model)!;
  const fallbackAccount = accountForPreset(input, input.fallback_model)!;
  if (
    fallbackAccount.weekly_headroom! - defaultAccount.weekly_headroom!
    >= config.headroom_gap
  ) {
    return { targetPreset: input.fallback_model, rule: "preset.fallback_by_gap" };
  }
  return { targetPreset: input.default_model, rule: "preset.default" };
}

function isStaleForValue(
  input: DecisionInput,
  account: AccountObservation | undefined,
  value: number | null | undefined,
  config: PersistentDecisionConfig,
): boolean {
  return account === undefined
    || account.observed_at === null
    || (Date.parse(input.now) - Date.parse(account.observed_at)) / 1_000
      > config.usage_stale_seconds
    || value === null
    || value === undefined;
}

function meetsShortFloorOrHasNoShortWindow(
  input: DecisionInput,
  account: AccountObservation | undefined,
  floor: number,
  config: PersistentDecisionConfig,
): boolean {
  return hasFreshObservationWithoutShortWindow(input, account, config)
    || (
      !isStaleForValue(input, account, account?.short_remaining_percent, config)
      && account!.short_remaining_percent! >= floor
    );
}

function hasFreshObservationWithoutShortWindow(
  input: DecisionInput,
  account: AccountObservation | undefined,
  config: PersistentDecisionConfig,
): boolean {
  return account?.short_remaining_percent === null
    && !isStaleForValue(input, account, 0, config);
}

function presetConfigFor(
  input: DecisionInput,
  config: PersistentDecisionConfig,
  preset: string,
): PresetDecisionConfig {
  return config.presets[preset]
    ?? config.provider_defaults[input.preset_providers[preset]!];
}

function accountForPreset(
  input: DecisionInput,
  preset: string,
): AccountObservation | undefined {
  return input.accounts[input.preset_providers[preset]!];
}

function uniquePresets(defaultModel: string, fallbackModel: string): string[] {
  return defaultModel === fallbackModel
    ? [defaultModel]
    : [defaultModel, fallbackModel];
}

function copyInput(input: DecisionInput): DecisionInput {
  return {
    ...input,
    preset_providers: { ...input.preset_providers },
    checkpoint_tokens_by_preset: { ...input.checkpoint_tokens_by_preset },
    accounts: {
      ...(input.accounts.claude ? { claude: { ...input.accounts.claude } } : {}),
      ...(input.accounts.codex ? { codex: { ...input.accounts.codex } } : {}),
    },
  };
}
