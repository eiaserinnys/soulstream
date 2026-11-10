/**
 * 후보 model preset id 목록에서 지금 쓸 수 있는 preset을 고르는 순수 함수.
 *
 * 노드가 광고한 preset만 후보로 남기고, 주간 잔여 한도가 바닥 아래면 건너뛴다.
 * 아무것도 쓸 수 없으면 첫 후보를 돌려주어 이후 검증 단계가 사유를 결정하게 한다.
 */

export const MODEL_PRESET_WEEKLY_HEADROOM_FLOOR_PERCENT = 1;

export interface UsablePresetCandidate {
  id: string;
  available: boolean;
  weekly_headroom?: { remaining_percent?: number | null } | null;
}

export function chooseUsablePresetId(
  candidateIds: readonly string[],
  presets: readonly UsablePresetCandidate[],
  floorPercent: number = MODEL_PRESET_WEEKLY_HEADROOM_FLOOR_PERCENT,
): string {
  const candidates = [...new Set(candidateIds)];
  const firstCandidate = candidates[0]!;

  const advertised = new Map(presets.map((preset) => [preset.id, preset]));
  const ordered = candidates.flatMap((id) => {
    const preset = advertised.get(id);
    return preset === undefined ? [] : [preset];
  });
  const withHeadroom = ordered.find((preset) =>
    preset.available
    && (preset.weekly_headroom?.remaining_percent == null
      || preset.weekly_headroom.remaining_percent >= floorPercent),
  );
  if (withHeadroom) return withHeadroom.id;
  return ordered.find((preset) => preset.available)?.id ?? firstCandidate;
}
