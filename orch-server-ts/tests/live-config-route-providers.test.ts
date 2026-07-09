import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  createLiveConfigRouteProviders,
  LiveConfigProviderError,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live config route provider adapters", () => {
  it("maps Python OAuth settings into auth route config", async () => {
    const configProvider = createConfigProvider({
      google_client_id: "google-client",
      google_client_secret: "google-secret",
      google_callback_url: "/api/auth/google/callback",
      jwt_secret: "jwt-secret",
      environment: "Development",
    });

    const providers = createLiveConfigRouteProviders(configProvider);

    await expect(providers.authRoutes.configProvider.getConfig()).resolves.toEqual({
      authEnabled: true,
      devModeEnabled: true,
      googleClientId: "google-client",
      googleClientSecret: "google-secret",
      callbackUrl: "/api/auth/google/callback",
      jwtSecretConfigured: true,
      cookieName: AUTH_COOKIE_NAME,
    });
    expect(configProvider.requireConfig).toHaveBeenCalledWith("google_client_id");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("google_client_secret");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("google_callback_url");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("jwt_secret");
    expect(configProvider.requireConfig).toHaveBeenCalledWith("environment");
  });

  it("preserves Python auth enabled and environment semantics", async () => {
    const devProviders = createLiveConfigRouteProviders(
      createConfigProvider({
        google_client_id: "",
        google_client_secret: "",
        google_callback_url: "",
        jwt_secret: "",
        environment: "dev",
      }),
    );
    const prodProviders = createLiveConfigRouteProviders(
      createConfigProvider({
        google_client_id: "google-client",
        google_client_secret: "google-secret",
        google_callback_url: "/callback",
        jwt_secret: "jwt-secret",
        environment: "production",
      }),
    );

    await expect(devProviders.authRoutes.configProvider.getConfig()).resolves.toMatchObject({
      authEnabled: false,
      devModeEnabled: true,
      jwtSecretConfigured: false,
    });
    await expect(prodProviders.authRoutes.configProvider.getConfig()).resolves.toMatchObject({
      authEnabled: true,
      devModeEnabled: false,
      jwtSecretConfigured: true,
    });
  });

  it("fails with typed errors when required auth config is missing or wrong type", async () => {
    const missing = createLiveConfigRouteProviders(
      createConfigProvider({
        google_client_id: "google-client",
        google_client_secret: "google-secret",
        jwt_secret: "jwt-secret",
        environment: "production",
      }),
    );
    await expect(missing.authRoutes.configProvider.getConfig()).rejects.toMatchObject({
      name: "LiveConfigProviderError",
      failures: [
        {
          owner: "auth",
          path: "authRoutes.configProvider",
          key: "google_callback_url",
          reason: "missing",
        },
      ],
    });

    const wrongType = createLiveConfigRouteProviders(
      createConfigProvider({
        google_client_id: "google-client",
        google_client_secret: "google-secret",
        google_callback_url: "/callback",
        jwt_secret: "jwt-secret",
        environment: 42,
      }),
    );
    await expect(
      wrongType.authRoutes.configProvider.getConfig(),
    ).rejects.toMatchObject({
      failures: [
        {
          owner: "auth",
          path: "authRoutes.configProvider",
          key: "environment",
          reason: "invalid_type",
        },
      ],
    });
  });

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
