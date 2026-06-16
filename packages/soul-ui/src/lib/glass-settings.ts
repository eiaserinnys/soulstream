export interface LiquidGlassSettings {
  enabled: boolean;
  refraction: number;
  blur: number;
  chromatic: number;
  specular: number;
  tint: number;
}

export const LIQUID_GLASS_SETTING_LIMITS = {
  refraction: { min: 0, max: 90, step: 1 },
  blur: { min: 0, max: 8, step: 0.1 },
  chromatic: { min: 0, max: 2.5, step: 0.1 },
  specular: { min: 0, max: 1.5, step: 0.05 },
  tint: { min: 0, max: 1, step: 0.05 },
} as const;

export const DEFAULT_LIQUID_GLASS_SETTINGS: LiquidGlassSettings = {
  enabled: true,
  refraction: 75,
  blur: 5,
  chromatic: 0.8,
  specular: 0.25,
  tint: 0.42,
};

export function normalizeLiquidGlassSettings(value: unknown): LiquidGlassSettings {
  const source = value && typeof value === "object"
    ? value as Partial<LiquidGlassSettings>
    : {};
  return {
    enabled: typeof source.enabled === "boolean"
      ? source.enabled
      : DEFAULT_LIQUID_GLASS_SETTINGS.enabled,
    refraction: numberInRange(
      source.refraction,
      LIQUID_GLASS_SETTING_LIMITS.refraction.min,
      LIQUID_GLASS_SETTING_LIMITS.refraction.max,
      DEFAULT_LIQUID_GLASS_SETTINGS.refraction,
    ),
    blur: numberInRange(
      source.blur,
      LIQUID_GLASS_SETTING_LIMITS.blur.min,
      LIQUID_GLASS_SETTING_LIMITS.blur.max,
      DEFAULT_LIQUID_GLASS_SETTINGS.blur,
    ),
    chromatic: numberInRange(
      source.chromatic,
      LIQUID_GLASS_SETTING_LIMITS.chromatic.min,
      LIQUID_GLASS_SETTING_LIMITS.chromatic.max,
      DEFAULT_LIQUID_GLASS_SETTINGS.chromatic,
    ),
    specular: numberInRange(
      source.specular,
      LIQUID_GLASS_SETTING_LIMITS.specular.min,
      LIQUID_GLASS_SETTING_LIMITS.specular.max,
      DEFAULT_LIQUID_GLASS_SETTINGS.specular,
    ),
    tint: numberInRange(
      source.tint,
      LIQUID_GLASS_SETTING_LIMITS.tint.min,
      LIQUID_GLASS_SETTING_LIMITS.tint.max,
      DEFAULT_LIQUID_GLASS_SETTINGS.tint,
    ),
  };
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value === "boolean") return fallback;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}
