import { describe, expect, it, vi } from "vitest";

import {
  createLiveAuthNativeVerifier,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live native Google auth verifier", () => {
  it("delegates ID token verification with the configured iOS audience", async () => {
    const googleClient = fakeGoogleClient({
      email: "native@example.com",
      name: "Native User",
      picture: "https://example.test/native.png",
    });
    const verifier = createLiveAuthNativeVerifier({
      configProvider: configWith({ google_ios_client_id: "ios-client-id" }),
      googleClient,
    });

    await expect(verifier("id-token")).resolves.toEqual({
      email: "native@example.com",
      name: "Native User",
      picture: "https://example.test/native.png",
    });
    expect(googleClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: "id-token",
      audience: "ios-client-id",
    });
  });

  it("fails explicitly when google_ios_client_id is missing or empty", async () => {
    const empty = createLiveAuthNativeVerifier({
      configProvider: configWith({ google_ios_client_id: "" }),
      googleClient: fakeGoogleClient({ email: "native@example.com" }),
    });
    const missing = createLiveAuthNativeVerifier({
      configProvider: configWith({}),
      googleClient: fakeGoogleClient({ email: "native@example.com" }),
    });

    await expect(empty("id-token")).rejects.toThrow("google_ios_client_id must be configured");
    await expect(missing("id-token")).rejects.toThrow("google_ios_client_id is required");
  });

  it("propagates verifier audience failures instead of decoding JWT payloads locally", async () => {
    const googleClient = {
      verifyIdToken: vi.fn(async () => {
        throw new Error("Wrong recipient");
      }),
    };
    const verifier = createLiveAuthNativeVerifier({
      configProvider: configWith({ google_ios_client_id: "ios-client-id" }),
      googleClient,
    });

    await expect(verifier("wrong-audience-token")).rejects.toThrow("Wrong recipient");
    expect(googleClient.verifyIdToken).toHaveBeenCalledTimes(1);
  });
});

function configWith(values: Record<string, unknown>): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => values),
    requireConfig: vi.fn(async (key: string) => {
      if (!(key in values)) throw new Error(`${key} is required`);
      return values[key];
    }),
  };
}

function fakeGoogleClient(payload: Record<string, unknown>) {
  return {
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => payload,
    })),
  };
}
