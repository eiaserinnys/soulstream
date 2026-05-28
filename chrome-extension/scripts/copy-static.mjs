import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const publicDir = resolve(root, "public");

rmSync(dist, { recursive: true, force: true });
cpSync(publicDir, dist, { recursive: true });
