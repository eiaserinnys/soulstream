import { describe, expect, it } from "vitest";
import { antigravityArguments, antigravityUserMessage } from "../../../src/engine/antigravity/params.js";
import { antigravityEnvironment } from "../../../src/engine/antigravity_env.js";

describe("Antigravity launch inputs", () => {
  it("uses one model and separated effort, explicit log, no timeout or positional user text", () => {
    const args = antigravityArguments({ prompt: "비밀", model: "gemini-3.8-flash", reasoningEffort: "low" }, "/state/agy.log", { name: "soulstream-test" });
    expect(args).toEqual(["--output-format", "stream-json", "--input-format", "stream-json", "--dangerously-skip-permissions", "--log-file", "/state/agy.log", "--model", "gemini-3.8-flash", "--effort", "low", "--agent", "soulstream-test"]);
    expect(antigravityUserMessage("한글\n둘째 줄")).toBe('{"event":"user","message":{"content":"한글\\n둘째 줄"}}\n');
  });
  it("resumes using the native ID without an agent definition", () => {
    const args = antigravityArguments({ prompt: "다음", resumeSessionId: "conversation" }, "/state/log");
    expect(args.slice(-2)).toEqual(["--conversation", "conversation"]);
    expect(args).not.toContain("--agent"); expect(args).not.toContain("--add-dir");
  });
  it.each(["minimal", "xhigh", "max", "ultra"])("rejects unsupported effort %s", (reasoningEffort) => {
    expect(() => antigravityArguments({ prompt: "x", reasoningEffort: reasoningEffort as "max" }, "/state/log")).toThrow(/effort/);
  });
  it("copies environment and removes exactly the three API routing keys", () => {
    const input = { GEMINI_API_KEY: "test-only", GOOGLE_API_KEY: "test-only", GOOGLE_GEMINI_BASE_URL: "test-only", PATH: "/bin", KEEP: "kept" };
    expect(antigravityEnvironment(input)).toEqual({ PATH: "/bin", KEEP: "kept" });
    expect(input).toHaveProperty("GEMINI_API_KEY");
  });
});
