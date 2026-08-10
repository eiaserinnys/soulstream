import { BuildArtifactReleaseMaterializer } from "./runner_release_materializer.js";
import { RunnerReleasePool } from "./runner_release_pool.js";

const args = parseArgs(process.argv.slice(2));
const materializer = new BuildArtifactReleaseMaterializer(args.artifacts);
const pool = new RunnerReleasePool(args.releases, materializer);
const release = await pool.resolveCurrentRelease();
await pool.ensureRelease(release);
process.stdout.write(`${JSON.stringify({
  release_id: release.releaseId,
  release_root: release.releaseRoot,
  runner_module_root: release.runnerModuleRoot,
})}\n`);

function parseArgs(argv: string[]): {
  artifacts: string;
  releases: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("prewarm requires --artifacts and --releases values");
    }
    values.set(key.slice(2), value);
  }
  return {
    artifacts: required(values.get("artifacts"), "--artifacts"),
    releases: required(values.get("releases"), "--releases"),
  };
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} required`);
  return value;
}
