import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryDirectory = fileURLToPath(new URL(
  "../src/control_plane/repositories/",
  import.meta.url,
));
const notificationRepository = "session_delivery_notification_repository.ts";
const projectionRepository =
  "session_delivery_notification_projection_repository.ts";
const repositorySource = readFileSync(
  `${repositoryDirectory}/${notificationRepository}`,
  "utf8",
);

describe("session delivery notification lock order", () => {
  it("enumerates every production repository that writes the outbox", () => {
    const writerFiles = readdirSync(repositoryDirectory)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => hasOutboxWrite(
        readFileSync(`${repositoryDirectory}/${name}`, "utf8"),
      ))
      .sort();

    expect(writerFiles).toEqual([
      projectionRepository,
      notificationRepository,
    ]);
  });

  it("keeps every cross-table notification writer on deliveries then outbox", () => {
    const crossTableWriters = methodBodies(repositorySource)
      .filter(({ body }) =>
        hasOutboxWrite(body)
        && body.includes("UPDATE session_deliveries")
      );

    expect(crossTableWriters.map(({ name }) => name)).toEqual([
      "stageWithQueuedDelivery",
      "markPublished",
      "retry",
      "deadLetter",
      "requeueDeadLetter",
      "expireStaleNotificationAttempts",
    ]);
    for (const { name, body } of crossTableWriters) {
      const deliveryBoundary = firstIndex(
        body.indexOf("UPDATE session_deliveries"),
        body.indexOf("lockSessionDelivery("),
        body.indexOf("lockSessionDeliveries("),
      );
      const outboxWrite = firstIndex(
        body.indexOf("UPDATE session_delivery_notification_outbox"),
        body.indexOf("INSERT INTO session_delivery_notification_outbox"),
      );
      expect(deliveryBoundary, `${name} must lock or write delivery first`)
        .toBeGreaterThanOrEqual(0);
      expect(deliveryBoundary, `${name} must reach delivery before outbox`)
        .toBeLessThan(outboxWrite);
    }
  });
});

function methodBodies(source: string): Array<{ name: string; body: string }> {
  const matches = [...source.matchAll(/^  async (\w+)\(/gm)];
  return matches.map((match, index) => ({
    name: match[1]!,
    body: source.slice(
      match.index,
      matches[index + 1]?.index ?? source.lastIndexOf("\n}"),
    ),
  }));
}

function hasOutboxWrite(body: string): boolean {
  return body.includes("UPDATE session_delivery_notification_outbox")
    || body.includes("INSERT INTO session_delivery_notification_outbox");
}

function firstIndex(...indexes: number[]): number {
  const present = indexes.filter((index) => index >= 0);
  return present.length === 0 ? -1 : Math.min(...present);
}
