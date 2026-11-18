import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import { standardWebhookHeaders } from "../src/webhooks/standard_webhook_signature.js";

const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

describe("standard webhook signature", () => {
  it("produces headers that standardwebhooks verifies", () => {
    const body = JSON.stringify({ id: "sub:session:1", type: "session.reply" });
    const now = Date.now();
    const headers = standardWebhookHeaders({ secret, webhookId: "sub:session:1", body, now });

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["webhook-id"]).toBe("sub:session:1");
    expect(headers["webhook-timestamp"]).toBe(String(Math.floor(now / 1000)));
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
  });

  it("adds the previous secret signature only while the rotation window is open", () => {
    const body = "{}";
    const now = Date.now();
    const previousSecret = {
      secret: `whsec_${Buffer.alloc(32, 10).toString("base64")}`,
      until: now + 60_000,
    };

    const rotating = standardWebhookHeaders({
      secret,
      webhookId: "id-1",
      body,
      previousSecret,
      now,
    });
    expect(rotating["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(new Webhook(previousSecret.secret).verify(body, rotating)).toEqual({});

    const expired = standardWebhookHeaders({
      secret,
      webhookId: "id-1",
      body,
      previousSecret: { ...previousSecret, until: now - 1 },
      now,
    });
    expect(expired["webhook-signature"]!.split(" ")).toHaveLength(1);
  });
});
