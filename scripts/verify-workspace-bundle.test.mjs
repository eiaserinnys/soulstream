import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findExternalWorkspaceImports,
  verifyWorkspaceBundle,
} from "./verify-workspace-bundle.mjs";

test("accepts a bundle with no external workspace imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-bundle-contract-"));
  const bundle = join(directory, "main.js");
  try {
    await writeFile(bundle, 'import Fastify from "fastify";\n', "utf8");
    await verifyWorkspaceBundle([bundle]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects every external @soulstream workspace import form", async () => {
  const source = [
    'import value from "@soulstream/new-package";',
    'export { other } from "@soulstream/other-package";',
    'await import("@soulstream/dynamic-package");',
    'require("@soulstream/legacy-package");',
  ].join("\n");
  assert.deepEqual(findExternalWorkspaceImports(source), [
    "@soulstream/new-package",
    "@soulstream/other-package",
    "@soulstream/dynamic-package",
    "@soulstream/legacy-package",
  ]);

  const directory = await mkdtemp(join(tmpdir(), "soulstream-bundle-contract-"));
  const bundle = join(directory, "main.js");
  try {
    await writeFile(bundle, source, "utf8");
    await assert.rejects(
      () => verifyWorkspaceBundle([bundle]),
      /external workspace import @soulstream\/new-package/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
