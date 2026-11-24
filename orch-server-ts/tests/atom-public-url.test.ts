import { describe, expect, it, vi } from "vitest";

import {
  createAtomPublicUrlResolver,
  resolveAtomPublicUrl,
} from "../src/atom/atom_public_url.js";
import {
  createLiveConfigRouteProviders,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("resolveAtomPublicUrl", () => {
  it("1. uses the explicit ATOM_PUBLIC_URL and strips the trailing slash", () => {
    expect(
      resolveAtomPublicUrl({
        atomEnabled: true,
        atomServerUrl: "http://127.0.0.1:4200",
        atomPublicUrl: "https://host.example.test:8443/",
      }),
    ).toBe("https://host.example.test:8443");
  });

  it("2. falls back to a non-loopback ATOM_SERVER_URL", () => {
    expect(
      resolveAtomPublicUrl({
        atomEnabled: true,
        atomServerUrl: "https://atom.example.test/",
        atomPublicUrl: "",
      }),
    ).toBe("https://atom.example.test");
  });

  it("3. returns null for a loopback ATOM_SERVER_URL", () => {
    for (const serverUrl of [
      "http://127.0.0.1:4200",
      "http://127.5.6.7:4200",
      "http://localhost:4200",
      "http://[::1]:4200",
      "http://0.0.0.0:4200",
      "",
    ]) {
      expect(
        resolveAtomPublicUrl({ atomEnabled: true, atomServerUrl: serverUrl, atomPublicUrl: null }),
      ).toBeNull();
    }
  });

  it("4. returns null when atom is disabled", () => {
    expect(
      resolveAtomPublicUrl({
        atomEnabled: false,
        atomServerUrl: "https://atom.example.test",
        atomPublicUrl: "https://public.example.test",
      }),
    ).toBeNull();
  });

  it("5. returns null and reports a value that is not an http(s) absolute URL", () => {
    for (const value of ["ftp://atom.example.test", "atom.example.test", "javascript:alert(1)", "/relative"]) {
      const onInvalid = vi.fn();
      expect(
        resolveAtomPublicUrl(
          { atomEnabled: true, atomServerUrl: "https://atom.example.test", atomPublicUrl: value },
          onInvalid,
        ),
      ).toBeNull();
      expect(onInvalid).toHaveBeenCalledWith(value);
    }
  });
});

describe("createAtomPublicUrlResolver", () => {
  it("warns once per invalid value", () => {
    const warn = vi.fn();
    const resolve = createAtomPublicUrlResolver(warn);
    const input = { atomEnabled: true, atomServerUrl: "", atomPublicUrl: "ftp://bad.example.test" };
    resolve(input);
    resolve(input);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("ftp://bad.example.test");
  });
});

describe("public status live config adapter", () => {
  it("maps ATOM_PUBLIC_URL and ATOM_SERVER_URL into atomPublicUrl", async () => {
    const providers = (config: Record<string, unknown>) => {
      const boundary: LiveConfigProviderBoundary = {
        getConfig: vi.fn(async () => config),
        requireConfig: vi.fn(async (key: string) => config[key]),
      };
      return createLiveConfigRouteProviders(boundary).publicStatusRoutes.configProvider.getConfig();
    };
    const base = { google_client_id: "", atom_enabled: true };
    await expect(
      providers({ ...base, atom_server_url: "http://127.0.0.1:4200", atom_public_url: "https://a.example.test:8443" }),
    ).resolves.toMatchObject({ atomPublicUrl: "https://a.example.test:8443" });
    await expect(
      providers({ ...base, atom_server_url: "https://atom.example.test" }),
    ).resolves.toMatchObject({ atomPublicUrl: "https://atom.example.test" });
    await expect(
      providers({ ...base, atom_server_url: "http://127.0.0.1:4200" }),
    ).resolves.toMatchObject({ atomPublicUrl: null });
    await expect(
      providers({ ...base, atom_enabled: false, atom_server_url: "https://atom.example.test" }),
    ).resolves.toMatchObject({ atomPublicUrl: null });
  });
});
