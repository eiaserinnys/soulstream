import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";

const distRunner = new URL("../dist/runner/", import.meta.url);
await mkdir(distRunner, { recursive: true });
await writeFile(
  new URL("package.json", distRunner),
  `${JSON.stringify({ type: "module" })}\n`,
  "utf8",
);
// 격리 러너는 자기 릴리스 스냅샷 안의 helper로만 netns를 만든다.
for (const name of ["session-netns-helper.py", "session_netns_network.py"]) {
  const destination = new URL(name, distRunner);
  await copyFile(new URL(name, import.meta.url), destination);
  await chmod(destination, name === "session-netns-helper.py" ? 0o755 : 0o644);
}
