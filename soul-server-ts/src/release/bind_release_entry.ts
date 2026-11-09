import { writeSync } from "node:fs";

import { bindErrorLines, bindPortableRelease } from "./bind_release.js";

const USAGE = "--release-dir <dir> --env-file <file>";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await bindPortableRelease(options);
  process.stdout.write(
    `bind-release: bound ${result.manifest.source_commit} `
    + `manifest=${result.manifest.manifest_id} path=${result.manifestPath}`
    + `${result.envDocumentPresent ? "" : " (no env document)"}\n`,
  );
} catch (error) {
  for (const line of bindErrorLines(error)) writeSync(2, `${line}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): { releaseDirectory: string; envFile: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`usage: bind-release ${USAGE}`);
    }
    if (values.has(key.slice(2))) throw new Error(`duplicate option: ${key}`);
    values.set(key.slice(2), value);
  }
  const releaseDirectory = values.get("release-dir");
  const envFile = values.get("env-file");
  if (!releaseDirectory) throw new Error(`--release-dir is required: ${USAGE}`);
  if (!envFile) throw new Error(`--env-file is required: ${USAGE}`);
  const unknown = [...values.keys()].filter((key) => key !== "release-dir" && key !== "env-file");
  const firstUnknown = unknown[0];
  if (firstUnknown) throw new Error(`unknown option: --${firstUnknown}`);
  return { releaseDirectory, envFile };
}
