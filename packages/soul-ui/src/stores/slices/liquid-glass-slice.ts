import type { StateCreator } from "zustand";
import {
  normalizeLiquidGlassSettings,
  type LiquidGlassSettings,
} from "../../lib/glass-settings";
import type { DashboardActions, DashboardState } from "../dashboard-store-types";

export type LiquidGlassSlice = Pick<DashboardState, "liquidGlass"> &
  Pick<DashboardActions, "setLiquidGlass" | "setLiquidGlassEnabled">;

export const createLiquidGlassSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  LiquidGlassSlice
> = (set, get) => ({
  liquidGlass: normalizeLiquidGlassSettings(null),

  setLiquidGlass: (settings: Partial<LiquidGlassSettings>) => {
    const next = normalizeLiquidGlassSettings({
      ...get().liquidGlass,
      ...settings,
    });
    set({ liquidGlass: next });
  },

  setLiquidGlassEnabled: (enabled: boolean) => {
    const next = normalizeLiquidGlassSettings({
      ...get().liquidGlass,
      enabled,
    });
    set({ liquidGlass: next });
  },
});
