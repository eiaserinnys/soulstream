import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  // Node >=18.20.2 refuses to spawn .cmd/.bat without a shell (CVE-2024-27980).
  // Without this every Windows deploy node fails the build hook with EINVAL.
  shell: process.platform === "win32",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);

function optionValue(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
