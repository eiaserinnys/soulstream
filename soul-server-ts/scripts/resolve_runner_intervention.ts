import { resolve } from "node:path";

import { resolveAmbiguousRunnerIntervention } from
  "../src/runner/runner_intervention_resolution.js";

const args = process.argv.slice(2);
const databasePath = readArgument(args, "--database");
const interventionId = readArgument(args, "--intervention-id");
const resolution = readArgument(args, "--resolution");
if (
  !databasePath
  || !interventionId
  || (resolution !== "applied" && resolution !== "not_applied")
  || !args.includes("--confirm-runner-stopped")
) {
  throw new Error(
    "usage: resolve_runner_intervention --database <runner.sqlite> "
      + "--intervention-id <id> --resolution <applied|not_applied> "
      + "--confirm-runner-stopped",
  );
}

const result = await resolveAmbiguousRunnerIntervention(
  resolve(databasePath),
  interventionId,
  resolution,
);
process.stdout.write(`${JSON.stringify({ status: "ok", ...result }, null, 2)}\n`);

function readArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
