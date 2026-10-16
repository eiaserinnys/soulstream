import { describe, expect, it } from "vitest";
import {
  mapAttachmentEventSignals,
  mapAttachmentMessageSignals,
  sameAttachmentMessageSignals,
} from "./attachment-event-signals";

describe("attachment event signals", () => {
  it("maps wire fields without cloning arrays or dropping empty values", () => {
    const ids: string[] = [];
    const paths: string[] = [];

    const signals = mapAttachmentEventSignals({
      attachment_ids: ids,
      attachment_count: 0,
      attachments: paths,
      node_id: "node-a",
    });

    expect(signals).toEqual({
      attachmentIds: [],
      attachmentCount: 0,
      attachmentPaths: [],
      attachmentNodeId: "node-a",
    });
    expect(signals.attachmentIds).toBe(ids);
    expect(signals.attachmentPaths).toBe(paths);
    expect(mapAttachmentEventSignals({})).toEqual({});
  });

  it("derives complete display IDs from the durable attachment ID array", () => {
    const ids = ["asset-a"];
    const signals = mapAttachmentMessageSignals({
      attachmentIds: ids,
      attachmentCount: 1,
    }, true);

    expect(signals.attachmentDisplayIds).toBe(ids);
    expect(mapAttachmentMessageSignals({})).toEqual({});
  });

  it("compares attachment array identity and scalar signals", () => {
    const ids = ["asset-a"];
    const base = mapAttachmentMessageSignals({
      attachmentIds: ids,
      attachmentCount: 1,
      attachmentPaths: ["/incoming/a.png"],
      attachmentNodeId: "node-a",
    }, true);

    expect(sameAttachmentMessageSignals(base, { ...base })).toBe(true);
    expect(sameAttachmentMessageSignals(base, { ...base, attachmentIds: [...ids] })).toBe(false);
    expect(sameAttachmentMessageSignals(base, { ...base, attachmentCount: 2 })).toBe(false);
    expect(sameAttachmentMessageSignals(base, { ...base, attachmentNodeId: "node-b" })).toBe(false);
    expect(sameAttachmentMessageSignals(base, { ...base, attachmentDisplayIds: [...ids] })).toBe(false);
  });
});
