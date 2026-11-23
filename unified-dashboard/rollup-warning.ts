import type { UserConfig } from "vite";

type RollupOnWarn = NonNullable<NonNullable<NonNullable<UserConfig["build"]>["rollupOptions"]>["onwarn"]>;

export const handleRollupWarning: RollupOnWarn = (warning, warn) => {
  if (warning.code === "CIRCULAR_CHUNK"
    || (warning.code === "CIRCULAR_DEPENDENCY" && typeof warning.message === "string" && warning.message.includes("Circular chunk:"))) {
    throw new Error(warning.message || "Circular chunk detected");
  }
  warn(warning);
};
