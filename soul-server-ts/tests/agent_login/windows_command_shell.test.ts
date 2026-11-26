import { commandShellSpawn } from "@soulstream/executable-path";
import { describe, expect, it } from "vitest";

describe("commandShellSpawn", () => {
  it("passes a Windows .cmd shim through the shell and quotes a path with spaces", () => {
    const target = commandShellSpawn("C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd", ["auth", "login"], "win32");
    expect(target).toEqual({
      command: '"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd"',
      args: ["auth", "login"],
      options: { shell: true },
    });
  });

  it("leaves a .cmd path without spaces and plain arguments unquoted", () => {
    expect(commandShellSpawn("C:\\npm\\codex.CMD", ["app-server"], "win32")).toEqual({
      command: "C:\\npm\\codex.CMD",
      args: ["app-server"],
      options: { shell: true },
    });
  });

  it("quotes an argument that has a space or a shell metacharacter", () => {
    const target = commandShellSpawn("C:\\npm\\codex.cmd", ["--config", "a b", "x&y"], "win32");
    expect(target.args).toEqual(["--config", '"a b"', '"x&y"']);
  });

  it("refuses an argument that cannot be quoted safely", () => {
    expect(() => commandShellSpawn("C:\\npm\\codex.cmd", ['a"b'], "win32")).toThrow(/quote/);
  });

  it("does not touch .exe files or other platforms", () => {
    expect(commandShellSpawn("C:\\Program Files\\Claude\\claude.exe", ["auth", "login"], "win32")).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["auth", "login"],
      options: {},
    });
    expect(commandShellSpawn("/usr/local/bin/codex.cmd", ["login"], "linux")).toEqual({
      command: "/usr/local/bin/codex.cmd",
      args: ["login"],
      options: {},
    });
  });
});
