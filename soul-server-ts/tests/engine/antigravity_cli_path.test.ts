import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAntigravityCliPath } from "../../src/engine/antigravity_cli_path.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";

it("resolves explicit, PATH, then HOME local binary without executing it", () => {
  const home = makeTempDirSync("agy-cli-");
  const bin = join(home, ".local/bin"); mkdirSync(bin, { recursive: true });
  const cli = join(bin, "agy"); writeFileSync(cli, "#!/bin/sh\nexit 91\n"); chmodSync(cli, 0o700);
  expect(resolveAntigravityCliPath({ AGY_CLI_PATH: cli, PATH: "", HOME: "" })).toEqual({ path: cli, source: "AGY_CLI_PATH" });
  expect(resolveAntigravityCliPath({ PATH: bin, HOME: "" })).toEqual({ path: cli, source: "PATH" });
  expect(resolveAntigravityCliPath({ PATH: "", HOME: home })).toEqual({ path: cli, source: "HOME_LOCAL_BIN" });
});
it("returns undefined on a node without agy", () => {
  expect(resolveAntigravityCliPath({ AGY_CLI_PATH: "/missing/agy", PATH: "", HOME: "" })).toBeUndefined();
});
