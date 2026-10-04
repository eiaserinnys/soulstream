import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";
export function dashboardBuildIdentity(command: string, root: string): string {
  if (command !== "build") return "dev";
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Dashboard build requires a git commit SHA");
  return sha;
}
export function dashboardBuildManifest(buildId: string): Plugin {
  return {
    name: "dashboard-build-identity",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: JSON.stringify({ build_id: buildId }) + "\n",
      });
    },
  };
}
