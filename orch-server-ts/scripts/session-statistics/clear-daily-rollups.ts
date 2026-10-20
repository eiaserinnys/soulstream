import postgres from "postgres";
import { resolveSessionStatisticsDateSlice } from "../../src/usage/session_statistics_period.js";

// Explicit maintenance operation. Usage: tsx clear-daily-rollups.ts --day YYYY-MM-DD
// or: tsx clear-daily-rollups.ts --version N
const [flag, value, ...extra] = process.argv.slice(2);
if (extra.length || !value || (flag !== "--day" && flag !== "--version")) {
  throw new Error("Expected --day YYYY-MM-DD or --version N");
}
if (flag === "--day") resolveSessionStatisticsDateSlice(value, new Date().toISOString());
const version = flag === "--version" ? Number(value) : null;
if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new Error("Invalid aggregation version");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1 });
try {
  const deleted = flag === "--day"
    ? await sql`DELETE FROM session_statistics_daily_batches WHERE day = ${value}::date RETURNING day`
    : await sql`DELETE FROM session_statistics_daily_batches WHERE aggregation_version = ${version} RETURNING day`;
  process.stdout.write(`${JSON.stringify({ deleted_dates: deleted.length, [flag.slice(2)]: value })}\n`);
} finally {
  await sql.end();
}
