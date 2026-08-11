import { BuildArtifactReleaseMaterializer } from "./runner_release_materializer.js";
import { RunnerReleasePool } from "./runner_release_pool.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

const args = parseArgs(process.argv.slice(2));
if (args.mode === "initialize-database") {
  const outbox = await RunnerSqliteEventOutbox.create(args.database);
  outbox.close();
  process.stdout.write(`${JSON.stringify({ database: args.database })}\n`);
} else {
  const materializer = new BuildArtifactReleaseMaterializer(args.artifacts);
  const pool = new RunnerReleasePool(args.releases, materializer);
  const release = await pool.resolveCurrentRelease();
  await pool.ensureRelease(release);
  process.stdout.write(`${JSON.stringify({
    release_id: release.releaseId,
    release_root: release.releaseRoot,
    runner_module_root: release.runnerModuleRoot,
  })}\n`);
}

function parseArgs(argv: string[]):
  | { mode: "prewarm"; artifacts: string; releases: string }
  | { mode: "initialize-database"; database: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("prewarm requires --artifacts and --releases values");
    }
    values.set(key.slice(2), value);
  }
  if (values.has("database")) {
    if (values.size !== 1) {
      throw new Error("database initialization accepts only --database");
    }
    return {
      mode: "initialize-database",
      database: required(values.get("database"), "--database"),
    };
  }
  return {
    mode: "prewarm",
    artifacts: required(values.get("artifacts"), "--artifacts"),
    releases: required(values.get("releases"), "--releases"),
  };
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} required`);
  return value;
}
