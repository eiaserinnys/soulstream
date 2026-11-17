import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("runner initialization", () => {
  it("raises the stack trace limit to 50 in the runner process", () => {
    const script = `process.argv[2] = "--config"; process.argv[3] = "/nonexistent/runner.json"; import("./src/runner/runner_entry.ts").catch(() => console.log("stack-limit=" + Error.stackTraceLimit));`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
    expect(output).toContain("stack-limit=50");
  });
});
