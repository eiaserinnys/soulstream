import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import postgres from "postgres";
import { readDatabaseUrl } from "./migration-contract.mjs";

class BoardR2ImportError extends Error {}

// Explicit one-time migration only. Runtime does not import or read these env keys.
export async function importBoardR2(sql, env) {
  const value = {
    endpoint: env.R2_BOARD_ASSETS_ENDPOINT?.trim(),
    bucket: env.R2_BOARD_ASSETS_BUCKET?.trim(),
    accessKeyId: env.R2_BOARD_ASSETS_ACCESS_KEY_ID?.trim(),
    secretAccessKey: env.R2_BOARD_ASSETS_SECRET_ACCESS_KEY,
  };
  if (!Object.values(value).every(v => typeof v === "string" && v.length > 0)
    || !/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com\/?$/.test(value.endpoint)
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)) {
    throw new BoardR2ImportError("Board R2 environment is missing or invalid. No settings were changed.");
  }
  value.endpoint = value.endpoint.replace(/\/$/, "");
  const rows = await sql`
    INSERT INTO system_settings (setting_key, value, version, updated_by)
    VALUES ('board_r2', ${sql.json(value)}, 1, 'import:board-r2-env')
    ON CONFLICT (setting_key) DO UPDATE
    SET value = EXCLUDED.value, version = system_settings.version + 1,
        updated_at = NOW(), updated_by = EXCLUDED.updated_by
    WHERE system_settings.value = '{"endpoint":"","bucket":"","accessKeyId":"","secretAccessKey":""}'::jsonb
    RETURNING version
  `;
  if (!rows.length) throw new BoardR2ImportError("Existing board_r2 settings were found. Import stopped without overwriting them.");
  return { imported: true, version: Number(rows[0].version) };
}
export async function boardR2Status(sql) {
  const rows = await sql`
    SELECT version,
      COALESCE(length(value->>'endpoint') > 0, false) AS endpoint_configured,
      COALESCE(length(value->>'bucket') > 0, false) AS bucket_configured,
      COALESCE(length(value->>'accessKeyId') > 0, false) AS access_key_id_configured,
      COALESCE(length(value->>'secretAccessKey') > 0, false) AS secret_access_key_configured
    FROM system_settings WHERE setting_key = 'board_r2'
  `;
  return rows[0] ?? { present: false };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !["import", "status"].includes(args[0]) || args[1] !== "--env-file") {
    throw new BoardR2ImportError("Usage: node import-board-r2.mjs import|status --env-file <service-env-path>");
  }
  const env = {};
  const loaded = dotenv.config({ path: resolve(args[2]), processEnv: env });
  if (loaded.error) throw new BoardR2ImportError("Unable to load the specified environment file.");
  const sql = postgres(readDatabaseUrl(env), { max: 1, connect_timeout: 5, idle_timeout: 1 });
  try { console.log(JSON.stringify(args[0] === "import" ? await importBoardR2(sql, env) : await boardR2Status(sql))); }
  finally { await sql.end({ timeout: 5 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof BoardR2ImportError ? error.message : "Board R2 operation failed; no credential values are printed. Check database access.");
    process.exitCode = 1;
  });
}
