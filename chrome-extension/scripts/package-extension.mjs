import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const releaseDir = resolve(root, "release");

function parseTag(argv) {
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex >= 0) {
    return argv[tagIndex + 1] ?? "";
  }

  const tagPrefix = "--tag=";
  const tagArg = argv.find((arg) => arg.startsWith(tagPrefix));
  if (tagArg) {
    return tagArg.slice(tagPrefix.length);
  }

  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  return "manual";
}

function assertSafeTag(tag) {
  if (!tag) {
    throw new Error("Missing tag. Pass --tag chrome-extension-vX.Y.Z.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
    throw new Error(`Unsafe tag for artifact filename: ${tag}`);
  }
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: "pipe", ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${message}`);
  }
}

function assertDistReady() {
  if (!existsSync(dist)) {
    throw new Error("Missing dist/. Run `pnpm --dir chrome-extension build` first.");
  }
  if (!existsSync(resolve(dist, "manifest.json"))) {
    throw new Error("Missing dist/manifest.json. The zip would not be loadable as an unpacked extension.");
  }
}

function assertZipManifest(zipPath) {
  const listing = run("unzip", ["-l", zipPath], { encoding: "utf8" });
  const zipEntries = listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter(Boolean);
  const hasRootManifest = zipEntries.includes("manifest.json");

  if (!hasRootManifest) {
    throw new Error(`${basename(zipPath)} does not contain root manifest.json.`);
  }
}

const tag = parseTag(process.argv.slice(2));
assertSafeTag(tag);
assertDistReady();

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

const zipPath = resolve(releaseDir, `soulstream-chrome-extension-${tag}.zip`);

run("zip", ["-qr", zipPath, "."], { cwd: dist, stdio: "inherit" });
assertZipManifest(zipPath);

console.log(zipPath);
