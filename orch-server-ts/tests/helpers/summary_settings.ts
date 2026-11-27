import {
  SUMMARY_SETTINGS_OFF,
  type SummarySettingsReader,
  type SummarySettingsValue,
} from "../../src/settings/summary_settings.js";

/** The operating order the first-run seed produces for the production config. */
export const OPERATING_SUMMARY_SETTINGS: SummarySettingsValue = {
  turn: { enabled: true, model_presets: ["claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna"] },
  session: { enabled: true, model_presets: ["claude-sonnet", "codex-5.6-terra"] },
};

export function summarySettingsReader(
  value: SummarySettingsValue = SUMMARY_SETTINGS_OFF,
): SummarySettingsReader & { set(next: SummarySettingsValue): void } {
  let current = value;
  return { current: () => current, set: (next) => { current = next; } };
}
