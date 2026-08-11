import { mkdir, writeFile } from "node:fs/promises";

await mkdir(new URL("../dist/runner/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../dist/runner/package.json", import.meta.url),
  `${JSON.stringify({ type: "module" })}\n`,
  "utf8",
);
