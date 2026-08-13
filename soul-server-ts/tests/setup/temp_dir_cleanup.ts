import { afterAll } from "vitest";

import { removeTrackedTempDirs } from "../helpers/temp_dir.js";

// Runs once per test file. Directories created through `makeTempDir` are
// registered in a module-scoped registry that vitest isolates per file, so this
// removes exactly what that file made.
afterAll(async () => {
  await removeTrackedTempDirs();
});
