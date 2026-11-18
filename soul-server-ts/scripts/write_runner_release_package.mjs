import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const distRunner = resolve(scriptsRoot, "..", process.env.SOUL_DIST_DIR ?? "dist", "runner");
await mkdir(distRunner, { recursive: true });
await writeFile(
  join(distRunner, "package.json"),
  `${JSON.stringify({ type: "module" })}\n`,
  "utf8",
);
// 격리 러너는 자기 릴리스 스냅샷 안의 helper로만 netns를 만든다.
for (const name of ["session-netns-helper.py", "session_netns_network.py"]) {
  const destination = join(distRunner, name);
  await copyFile(join(scriptsRoot, name), destination);
  await chmod(destination, name === "session-netns-helper.py" ? 0o755 : 0o644);
}
