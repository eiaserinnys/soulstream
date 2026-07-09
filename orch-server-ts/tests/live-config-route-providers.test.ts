import { describe, expect, it, vi } from "vitest";

import {
  createLiveConfigRouteProviders,
  LiveConfigProviderError,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live config route provider adapters", () => {
  it("maps Python public status settings from explicit config dependency", async () => {
    const configProvider = createConfigProvider({
      node_name: "orch-live",
      google_client_id: "google-client",
      atom_enabled: true,
    });

    const providers = createLiveConfigRouteProviders(configProvider);

    await expect(providers.publicStatusRoutes.configProvider.getConfig()).resolves.toEqual({
      nodeName: "orch-live",
      authEnabled: true,
      atomEnabled: true,
    });
    expect(configProvider.requireConfig).toHaveBeenCalledWith("google_client_id");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("atom_enabled");
  });

  it("treats an empty Python google_client_id as auth disabled", async () => {
    const providers = createLiveConfigRouteProviders(
      createConfigProvider({
        node_name: null,
        google_client_id: "",
        atom_enabled: false,
      }),
    );

    await expect(providers.publicStatusRoutes.configProvider.getConfig()).resolves.toEqual({
      nodeName: null,
      authEnabled: false,
      atomEnabled: false,
    });
  });

  it("maps enabled Python Atom settings without inventing key names", async () => {
    const configProvider = createConfigProvider({
      atom_enabled: true,
      atom_server_url: "https://atom.example.test/",
      atom_api_key: "secret",
      atom_root_node_id: "root-node",
    });

    const providers = createLiveConfigRouteProviders(configProvider);

    await expect(providers.atomRoutes.configProvider.getConfig()).resolves.toEqual({
      atomEnabled: true,
      atomServerUrl: "https://atom.example.test/",
      atomApiKey: "secret",
      atomRootNodeId: "root-node",
    });
    expect(configProvider.requireConfig).toHaveBeenCalledWith("atom_enabled");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("atom_server_url");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("atom_api_key");
  });

  it("preserves the Python disabled Atom contract without requiring URL or API key", async () => {
    const providers = createLiveConfigRouteProviders(
      createConfigProvider({
        atom_enabled: false,
      }),
    );

    await expect(providers.atomRoutes.configProvider.getConfig()).resolves.toEqual({
      atomEnabled: false,
      atomServerUrl: "",
      atomApiKey: "",
      atomRootNodeId: null,
    });
  });

  it("fails with typed errors when required public status config is missing", async () => {
    const providers = createLiveConfigRouteProviders(
      createConfigProvider({
        atom_enabled: true,
      }),
    );

    await expect(
      providers.publicStatusRoutes.configProvider.getConfig(),
    ).rejects.toMatchObject({
      name: "LiveConfigProviderError",
      failures: [
        {
          owner: "public.status",
          path: "publicStatusRoutes.configProvider",
          key: "google_client_id",
          reason: "missing",
        },
      ],
    });
  });

  it("fails with typed errors when required Atom config has the wrong type", async () => {
    const providers = createLiveConfigRouteProviders(
      createConfigProvider({
        atom_enabled: true,
        atom_server_url: 42,
        atom_api_key: "secret",
      }),
    );

    await expect(providers.atomRoutes.configProvider.getConfig()).rejects.toBeInstanceOf(
      LiveConfigProviderError,
    );
    await expect(
      providers.atomRoutes.configProvider.getConfig(),
    ).rejects.toMatchObject({
      failures: [
        {
          owner: "atom",
          path: "atomRoutes.configProvider",
          key: "atom_server_url",
          reason: "invalid_type",
        },
      ],
    });
  });
});

function createConfigProvider(
  config: Readonly<Record<string, unknown>>,
): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => config),
    requireConfig: vi.fn(async (key: string) => config[key]),
  };
}
