/**
 * SoulStream Server — 진입점.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createSoulStreamServer } from "./server";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.SOUL_STREAM_PORT ?? "5200", 10);
// 기본값: 프로젝트 내 dashboard/dist
const DASHBOARD_DIR =
  process.env.SOUL_STREAM_DASHBOARD_DIR ||
  resolve(__dirname, "../dashboard/dist");

const { start } = createSoulStreamServer({
  port: PORT,
  dashboardDir: DASHBOARD_DIR || undefined,
});

start().catch((err) => {
  console.error("Failed to start SoulStream server:", err);
  process.exit(1);
});
