import {
  copyFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoSharedMainStoreInodes,
  isolatedCacheEnvironment,
} from "../../src/runner/session_filesystem_cache.js";
import { ISOLATION_SHARED_DEPENDENCY_INODE } from "../../src/runner/session_filesystem_errors.js";
import { makeTempDir } from "../helpers/temp_dir.js";
import { createFakeHostPorts, touch } from "../helpers/session_isolation_host_fakes.js";

async function makeStoreFixture() {
  const root = await makeTempDir("b2-inode-");
  const store = join(root, "main-store");
  const content = "content-addressable-file\n";
  const hash = createHash("sha512").update(content).digest("hex");
  const storeFile = join(store, "files", hash.slice(0, 2), hash.slice(2));
  touch(root, `main-store/files/${hash.slice(0, 2)}/${hash.slice(2)}`, content, 0o644);

  const worktree = join(root, "worktree");
  const installed = join(worktree, "node_modules/.pnpm/pkg/index.js");
  mkdirSync(dirname(installed), { recursive: true, mode: 0o700 });

  return { root, store, storeFile, worktree, installed, content };
}

function portsFor(root: string, mainStorePath: string | null) {
  return {
    ports: createFakeHostPorts({ root, mainStorePath }),
  };
}

describe("assertNoSharedMainStoreInodes", () => {
  it("rejects a dependency file hardlinked to the main store", async () => {
    const fixture = await makeStoreFixture();
    linkSync(fixture.storeFile, fixture.installed);

    await expect(
      assertNoSharedMainStoreInodes({
        worktreeRoots: [fixture.worktree],
        ports: portsFor(fixture.root, fixture.store).ports,
      }),
    ).rejects.toMatchObject({ code: ISOLATION_SHARED_DEPENDENCY_INODE });

    // 거절 뒤에도 주 store 파일은 그대로다.
    expect(readFileSync(fixture.storeFile, "utf8")).toBe(fixture.content);
  });

  it("accepts an independently copied dependency file", async () => {
    const fixture = await makeStoreFixture();
    copyFileSync(fixture.storeFile, fixture.installed);

    await expect(
      assertNoSharedMainStoreInodes({
        worktreeRoots: [fixture.worktree],
        ports: portsFor(fixture.root, fixture.store).ports,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a hardlink that does not resolve to the main store", async () => {
    const fixture = await makeStoreFixture();
    // 주 store에 없는 내용끼리 hardlink면 nlink>1이지만 store inode가 아니다.
    const other = join(fixture.root, "other-content");
    touch(fixture.root, "other-content", "other\n", 0o644);
    linkSync(other, fixture.installed);

    await expect(
      assertNoSharedMainStoreInodes({
        worktreeRoots: [fixture.worktree],
        ports: portsFor(fixture.root, fixture.store).ports,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects node_modules that is itself a symlink", async () => {
    const fixture = await makeStoreFixture();
    rmSync(join(fixture.worktree, "node_modules"), { recursive: true, force: true });
    symlinkSync(join(fixture.root, "elsewhere"), join(fixture.worktree, "node_modules"));

    await expect(
      assertNoSharedMainStoreInodes({
        worktreeRoots: [fixture.worktree],
        ports: portsFor(fixture.root, fixture.store).ports,
      }),
    ).rejects.toMatchObject({ code: ISOLATION_SHARED_DEPENDENCY_INODE });
  });

  it("skips the sample when the host has no main store", async () => {
    const fixture = await makeStoreFixture();
    linkSync(fixture.storeFile, fixture.installed);

    await expect(
      assertNoSharedMainStoreInodes({
        worktreeRoots: [fixture.worktree],
        ports: portsFor(fixture.root, null).ports,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("isolatedCacheEnvironment", () => {
  it("points every tool cache at the shared isolated root", () => {
    const cacheRoot = "/home/eias/.local/share/soulstream/isolated-cache";
    const env = isolatedCacheEnvironment(cacheRoot, "/home/eias");

    expect(env).toEqual({
      npm_config_store_dir: join(cacheRoot, "pnpm-store"),
      npm_config_cache: join(cacheRoot, "npm"),
      XDG_CACHE_HOME: join(cacheRoot, "xdg"),
      COREPACK_HOME: join(cacheRoot, "corepack"),
      PIP_CACHE_DIR: join(cacheRoot, "pip"),
      UV_CACHE_DIR: join(cacheRoot, "uv"),
      CARGO_HOME: join(cacheRoot, "cargo"),
      SCCACHE_DIR: join(cacheRoot, "sccache"),
      PLAYWRIGHT_BROWSERS_PATH: "/home/eias/.cache/ms-playwright",
    });
  });
});
