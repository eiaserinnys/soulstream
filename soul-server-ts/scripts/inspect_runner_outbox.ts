import { resolve } from "node:path";

import { inspectRunnerOutboxCopy } from "../src/runner/runner_outbox_inspector.js";

const args = process.argv.slice(2);
const databaseIndex = args.indexOf("--database");
const databasePath = databaseIndex >= 0 ? args[databaseIndex + 1] : undefined;
if (!databasePath || !args.includes("--confirm-readonly-copy")) {
  throw new Error(
    "usage: inspect_runner_outbox --database <copied runner.sqlite> --confirm-readonly-copy",
  );
}

const report = inspectRunnerOutboxCopy(resolve(databasePath));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status === "quarantine_required") process.exitCode = 2;
