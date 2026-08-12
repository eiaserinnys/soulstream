import { describe, expect, it, vi } from "vitest";

import {
  renameWithTransientRetry,
  renameWithTransientRetrySync,
} from "../src/atomic_file_rename.js";

function renameError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename ${code}`), { code });
}

describe("bounded atomic rename retry", () => {
  it("retries transient EPERM to success", async () => {
    const renameFile = vi.fn()
      .mockRejectedValueOnce(renameError("EPERM"))
      .mockRejectedValueOnce(renameError("EPERM"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await renameWithTransientRetry("source", "destination", { renameFile, sleep });

    expect(renameFile).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("retries the synchronous rename used by lifecycle summaries", () => {
    const renameFile = vi.fn()
      .mockImplementationOnce(() => { throw renameError("EPERM"); })
      .mockImplementationOnce(() => { throw renameError("EBUSY"); })
      .mockReturnValue(undefined);
    const sleep = vi.fn();

    renameWithTransientRetrySync("source", "destination", { renameFile, sleep });

    expect(renameFile).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("propagates the last transient error after five retries", async () => {
    const renameFile = vi.fn().mockRejectedValue(renameError("EACCES"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithTransientRetry("source", "destination", {
      renameFile,
      sleep,
    })).rejects.toMatchObject({ code: "EACCES" });

    expect(renameFile).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("does not retry errors outside the transient allowlist", async () => {
    const renameFile = vi.fn().mockRejectedValue(renameError("ENOENT"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithTransientRetry("source", "destination", {
      renameFile,
      sleep,
    })).rejects.toMatchObject({ code: "ENOENT" });

    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
