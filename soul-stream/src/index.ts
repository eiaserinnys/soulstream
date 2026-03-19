/**
 * SoulStream Server — 진입점.
 */

import { createSoulStreamServer } from "./server";

const PORT = parseInt(process.env.SOUL_STREAM_PORT ?? "5200", 10);
const DASHBOARD_DIR = process.env.SOUL_STREAM_DASHBOARD_DIR ?? "";

const { start } = createSoulStreamServer({
  port: PORT,
  dashboardDir: DASHBOARD_DIR || undefined,
});

start().catch((err) => {
  console.error("Failed to start SoulStream server:", err);
  process.exit(1);
});
