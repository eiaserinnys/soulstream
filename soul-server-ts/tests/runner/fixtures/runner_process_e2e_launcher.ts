import { readFile } from "node:fs/promises";

import { RunnerProcessSpawner } from "../../../src/runner/runner_process_spawn.js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("runner E2E launcher requires an input path");
const input = JSON.parse(await readFile(inputPath, "utf8")) as Parameters<
  RunnerProcessSpawner["spawn"]
>[0];
await new RunnerProcessSpawner().spawn(input);
