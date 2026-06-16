import { RotateCcw } from "lucide-react";
import {
  Button,
  DEFAULT_LIQUID_GLASS_SETTINGS,
  LIQUID_GLASS_SETTING_LIMITS,
  Slider,
  Switch,
  useDashboardStore,
  type LiquidGlassSettings,
} from "@seosoyoung/soul-ui";

type NumericGlassKey = Exclude<keyof LiquidGlassSettings, "enabled">;

const SLIDERS: Array<{
  key: NumericGlassKey;
  label: string;
  digits: number;
}> = [
  { key: "refraction", label: "굴절", digits: 0 },
  { key: "blur", label: "블러", digits: 1 },
  { key: "chromatic", label: "색수차", digits: 1 },
  { key: "specular", label: "스페큘러", digits: 2 },
  { key: "tint", label: "틴트", digits: 2 },
];

export function LiquidGlassTab() {
  const liquidGlass = useDashboardStore((state) => state.liquidGlass);
  const setLiquidGlass = useDashboardStore((state) => state.setLiquidGlass);
  const setLiquidGlassEnabled = useDashboardStore((state) => state.setLiquidGlassEnabled);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-[14px] border border-[var(--lg-line)] bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">리퀴드 글래스</div>
          <div className="text-xs text-muted-foreground">WebGL</div>
        </div>
        <Switch
          checked={liquidGlass.enabled}
          onCheckedChange={(checked) => setLiquidGlassEnabled(checked)}
          aria-label="리퀴드 글래스"
        />
      </div>

      <div className="space-y-3 rounded-[14px] border border-[var(--lg-line)] bg-muted/20 px-3 py-3">
        {SLIDERS.map((item) => (
          <GlassSlider
            key={item.key}
            settingKey={item.key}
            label={item.label}
            value={liquidGlass[item.key]}
            digits={item.digits}
            disabled={!liquidGlass.enabled}
            onChange={(value) => setLiquidGlass({ [item.key]: value } as Partial<LiquidGlassSettings>)}
          />
        ))}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => setLiquidGlass(DEFAULT_LIQUID_GLASS_SETTINGS)}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          기본값
        </Button>
      </div>
    </div>
  );
}

function GlassSlider({
  settingKey,
  label,
  value,
  digits,
  disabled,
  onChange,
}: {
  settingKey: NumericGlassKey;
  label: string;
  value: number;
  digits: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const limits = LIQUID_GLASS_SETTING_LIMITS[settingKey];
  return (
    <label className="grid grid-cols-[minmax(5rem,8rem)_1fr_minmax(3.5rem,auto)] items-center gap-3 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <Slider
        value={value}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        disabled={disabled}
        onValueChange={(next) => {
          const nextValue = Array.isArray(next) ? next[0] ?? value : next;
          onChange(roundToStep(nextValue, limits.step));
        }}
      />
      <span className="text-right font-mono text-xs text-muted-foreground">
        {value.toFixed(digits)}
      </span>
    </label>
  );
}

function roundToStep(value: number, step: number): number {
  const digits = Math.max(0, countDecimals(step));
  return Number(value.toFixed(digits));
}

function countDecimals(value: number): number {
  const text = String(value);
  const index = text.indexOf(".");
  return index === -1 ? 0 : text.length - index - 1;
}
