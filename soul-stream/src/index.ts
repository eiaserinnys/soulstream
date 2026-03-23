/**
 * SoulStream Server — 진입점.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createSoulStreamServer } from "./server";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.SOUL_STREAM_PORT ?? "5200", 10);
// §8: SOUL_STREAM_DASHBOARD_DIR는 필수값. 없으면 즉시 에러.
const DASHBOARD_DIR = process.env.SOUL_STREAM_DASHBOARD_DIR;
if (!DASHBOARD_DIR) {
  throw new Error(
    "SOUL_STREAM_DASHBOARD_DIR is required. " +
    "Set it to the orchestrator-dashboard dist directory path."
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { start } = createSoulStreamServer({
  port: PORT,
  dashboardDir: DASHBOARD_DIR,
  databaseUrl,
});

start().catch((err) => {
  console.error("Failed to start SoulStream server:", err);
  process.exit(1);
});
