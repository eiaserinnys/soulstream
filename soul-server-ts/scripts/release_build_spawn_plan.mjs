/**
 * How the release build invokes pnpm, as data.
 *
 * Node 22 refuses to spawn a .cmd/.bat shim without a shell (EINVAL), so the
 * Windows branch has to opt into one. Keeping the decision pure lets the
 * Windows branch be verified from any host - the branch that took the Haniel
 * build hook, and with it the whole Windows node, down for seven hours.
 */
export function releaseBuildSpawnPlan(platform, { cwd, env }) {
  const windows = platform === "win32";
  return {
    command: windows ? "pnpm.cmd" : "pnpm",
    args: ["run", "build"],
    options: { cwd, env, shell: windows, stdio: "inherit" },
  };
}
