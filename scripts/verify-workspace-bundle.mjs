import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](@soulstream\/[^"']+)["']/g;

export function findExternalWorkspaceImports(source) {
  return [...source.matchAll(WORKSPACE_IMPORT_PATTERN)].map((match) => match[1]);
}

export async function verifyWorkspaceBundle(paths) {
  const violations = [];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const specifier of findExternalWorkspaceImports(source)) {
      violations.push({ path, specifier });
    }
  }
  if (violations.length === 0) return;

  const details = violations
    .map(({ path, specifier }) => `${path}: external workspace import ${specifier}`)
    .join("\n");
  throw new Error(
    `Workspace packages export raw TypeScript and must be bundled:\n${details}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error("Usage: verify-workspace-bundle.mjs <dist-file> [...]");
  }
  await verifyWorkspaceBundle(paths);
}
