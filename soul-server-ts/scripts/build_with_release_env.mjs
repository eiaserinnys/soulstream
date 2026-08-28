import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { verifyCentralSchemaPrerequisite } from
  "./verify-central-schema-prerequisite.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = optionValue(process.argv.slice(2), "--env-file");
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["run", "build"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    SOULSTREAM_RELEASE_ENV_FILE: resolve(envFile),
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const declaredEnv = dotenv.parse(await readFile(resolve(envFile), "utf8"));
const upstreamUrl = declaredEnv.SOULSTREAM_UPSTREAM_URL;
if (!upstreamUrl) {
  throw new Error("SOULSTREAM_UPSTREAM_URL is required in the deployment env document");
}
const releaseManifest = JSON.parse(await readFile(
  resolve(packageRoot, "dist", "release-manifest.json"),
  "utf8",
));
await verifyCentralSchemaPrerequisite({
  upstreamUrl,
  schemaGeneration: releaseManifest.schema_generation,
});
process.stdout.write("central database schema prerequisite verified\n");

function optionValue(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
