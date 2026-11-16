import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function chunks(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return chunks(child);
    return entry.isFile() && /^chunk-.*\.js$/.test(entry.name) ? [child] : [];
  }));
  return files.flat();
}

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Usage: verify-bundle-load.mjs <dist-file-or-directory> [...]");
const files = (await Promise.all(paths.map(chunks))).flat();
if (files.length === 0) throw new Error(`No bundle chunks found in: ${paths.join(", ")}`);

for (const file of files) {
  const result = spawnSync(process.execPath, [
    "--input-type=module", "-e", "await import(process.argv[1]); process.exit(0)",
    pathToFileURL(resolve(file)).href,
  ], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    console.error(`Bundle load failed: ${file}\n${result.stderr || result.error || result.signal}`);
    process.exit(1);
  }
}
console.log(`Bundle load verified: ${files.length} file(s)`);
