import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  parseDarwinProcessTable,
  readDarwinProcessTable,
} from "../../../src/engine/antigravity/darwin_process_table.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const SAMPLE = `
    1     0 Ss    Mon Nov  3 10:11:12 2025
  123     1 S     Tue Nov  4 09:00:01 2025
  456   123 S+    Tue Nov  4 09:00:02 2025
  789   123 Z     Tue Nov  4 09:00:03 2025
`;

describe("parseDarwinProcessTable", () => {
  it("parses pid, ppid, status and a normalized start time", () => {
    expect(parseDarwinProcessTable(SAMPLE)).toEqual([
      { pid: 1, ppid: 0, status: "Ss", startTime: "Mon Nov 3 10:11:12 2025" },
      { pid: 123, ppid: 1, status: "S", startTime: "Tue Nov 4 09:00:01 2025" },
      { pid: 456, ppid: 123, status: "S+", startTime: "Tue Nov 4 09:00:02 2025" },
      { pid: 789, ppid: 123, status: "Z", startTime: "Tue Nov 4 09:00:03 2025" },
    ]);
  });

  it("drops malformed rows instead of guessing", () => {
    const rows = parseDarwinProcessTable([
      "garbage",
      "  12   3 S",
      "  0 1 Ss Mon Nov 3 10:11:12 2025",
      "  12 -1 S Mon Nov 3 10:11:12 2025",
      "  12 3 S Mon Foo 3 10:11:12 2025",
      "  12 3 S Mon Nov 40 10:11:12 2025",
      "  12 3 S Mon Nov 3 25:11:12 2025",
      "",
    ].join("\n"));

    expect(rows).toEqual([]);
  });
});

describe("readDarwinProcessTable", () => {
  it("reads ps with a deterministic locale and bounded output", () => {
    vi.mocked(execFileSync).mockReturnValue(SAMPLE);

    expect(readDarwinProcessTable()).toHaveLength(4);
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/ps",
      ["-ax", "-o", "pid=,ppid=,stat=,lstart="],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
        env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }),
      },
    );
  });
});
