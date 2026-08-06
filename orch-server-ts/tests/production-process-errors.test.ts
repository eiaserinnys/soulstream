import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const productionMainUrl = new URL("../src/production_main.ts", import.meta.url).href;

function childScript(body: string): string {
  return `
    import { installProductionProcessErrorHandlers } from ${JSON.stringify(productionMainUrl)};
    installProductionProcessErrorHandlers();
    ${body}
  `;
}

describe("production process error policy", () => {
  it("logs a stray rejection and keeps the orchestrator process alive", async () => {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childScript(`
          Promise.reject(new Error("stray rejection"));
          setTimeout(() => console.log("PROCESS_STILL_ALIVE"), 20);
        `),
      ],
      { cwd: new URL("..", import.meta.url).pathname },
    );

    expect(result.stdout).toContain("PROCESS_STILL_ALIVE");
    expect(result.stderr).toContain("orchestrator.unhandled_rejection");
    expect(result.stderr).toContain("stray rejection");
  });

  it("logs an uncaught exception but preserves Node's fatal exit policy", async () => {
    let failure: { code?: number; stderr?: string } | undefined;
    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          childScript(`
            setTimeout(() => { throw new Error("corrupted state"); }, 0);
          `),
        ],
        { cwd: new URL("..", import.meta.url).pathname },
      );
    } catch (error) {
      failure = error as { code?: number; stderr?: string };
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain("orchestrator.uncaught_exception");
    expect(failure?.stderr).toContain("corrupted state");
  });
});
