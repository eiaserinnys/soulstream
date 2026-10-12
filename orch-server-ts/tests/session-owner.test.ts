import { describe, expect, it } from "vitest";
import { createSessionOwnerResolver, withVerifiedSessionOwner } from "../src/session/session_owner.js";

describe("durable session owner", () => {
  const user = { email: "owner@example.test", isAdmin: true, allowedFolderIds: [] };
  function resolver(rows: Record<string, Record<string, unknown>>) {
    return createSessionOwnerResolver({ getSession: async id => rows[id] ?? null,
      findUserByEmail: async email => email === user.email ? user : null,
      findExternalAgent: async id => id === "dot" ? { id, ownerEmail: user.email, enabled: true } : null });
  }
  it("retains earlier verified metadata after memory eviction and crosses delegation/succession", async () => {
    const resolve = resolver({ root: { metadata: [
      { type: "caller_info", value: { source: "browser", email: user.email } },
      { type: "caller_info", value: { source: "agent", display_name: "no email" } } ] },
      child: { caller_session_id: "root" }, successor: { predecessor_session_id: "child" } });
    expect(await resolve("successor")).toMatchObject({ ownerEmail: user.email, callerInfo: { source: "browser" } });
  });
  it("validates external agent ownership and blocks forged external email and relation loops", async () => {
    const resolve = resolver({ dot: { metadata: [{ type: "caller_info", value: { source: "external-llm", agent_id: "dot", email: user.email } }] },
      forged: { metadata: [{ type: "caller_info", value: { source: "external-llm", email: user.email } }] },
      loop: { caller_session_id: "loop" } });
    expect(await resolve("dot")).toMatchObject({ ownerEmail: user.email, callerInfo: { source: "external-llm", agent_id: "dot" } });
    expect(await resolve("forged")).toBeNull(); expect(await resolve("loop")).toBeNull();
  });
  it("accepts registered owners on system callers and ignores missing or unregistered emails", async () => {
    const resolve = resolver({
      owned: { metadata: [{ type: "caller_info", value: { source: "system", email: user.email } }] },
      missing: { metadata: [{ type: "caller_info", value: { source: "system" } }] },
      unregistered: { metadata: [{ type: "caller_info", value: { source: "system", email: "unknown@example.test" } }] },
    });
    expect(await resolve("owned")).toMatchObject({ ownerEmail: user.email, callerInfo: { source: "system" } });
    expect(await resolve("missing")).toBeNull();
    expect(await resolve("unregistered")).toBeNull();
  });
  it("resolves a browser card execution from its persisted execution-user lookup", async () => {
    const resolve = createSessionOwnerResolver({
      getSession: async id => id === "browser-execution"
        ? { metadata: [{ type: "caller_info", value: { source: "browser" } }] }
        : null,
      findUserByEmail: async email => email === user.email ? user : null,
      findExternalAgent: async () => null,
      findCardExecutionUser: async sessionId => sessionId === "browser-execution" ? user.email : null,
    });
    expect(await resolve("browser-execution")).toEqual({
      ownerEmail: user.email,
      callerInfo: { source: "browser", email: user.email },
    });
  });
  it("keeps actual agent identity while attaching verified human and external ownership", async () => {
    const sender = { source: "agent", agent_id: "roselin", user_id: "roselin", agent_name: "로젤린",
      display_name: "로젤린", avatar_url: "/portrait", agent_node: "node", email: "unverified" };
    const owner = { ownerEmail: user.email, callerInfo: { source: "browser", email: user.email } };
    expect(withVerifiedSessionOwner(sender, owner)).toEqual({ ...sender, email: user.email });
    const { email: _email, ...unownedSender } = sender;
    expect(withVerifiedSessionOwner(sender, null)).toEqual(unownedSender);
    const inherited = withVerifiedSessionOwner(sender, { ...owner, callerInfo: { source: "dot", external_agent_id: "dot", email: user.email } });
    expect(inherited).toEqual({ ...sender, email: user.email, external_agent_id: "dot" });
    const resolve = resolver({ child: { metadata: [{ type: "caller_info", value: inherited }] },
      successor: { predecessor_session_id: "child" } });
    expect(await resolve("successor")).toMatchObject({ ownerEmail: user.email, callerInfo: { source: "agent", agent_id: "roselin", user_id: "roselin", external_agent_id: "dot" } });
  });
});
