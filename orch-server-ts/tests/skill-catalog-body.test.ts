import { describe, expect, it, vi } from "vitest";
import type { AtomHttpClient, AtomHttpResponse } from "../src/atom/atom_routes.js";
import { loadAtomNodeBody, loadAtomNodeMetadata, parseSkillCatalogMarkdown } from "../src/skills/skill_catalog.js";

function clientFor(nodeId: string, parentNodeId: string | null, childCount: number, markdown: string) {
  const requests: string[] = [];
  const httpClient: AtomHttpClient = {
    get: vi.fn(async ({ url }): Promise<AtomHttpResponse> => {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === `/tree/${nodeId}`) {
        return { statusCode: 200, body: { id: nodeId, parent_node_id: parentNodeId, card: { version: 12 } } };
      }
      if (parsed.pathname === `/api/tree/${nodeId}/compile`) {
        return { statusCode: 200, body: { markdown } };
      }
      if (parsed.pathname === "/api/tree/outline") {
        return { statusCode: 200, body: { nodes: [{ id: nodeId, child_count: childCount }] } };
      }
      throw new Error(`Unexpected Atom URL ${url}`);
    }),
    post: vi.fn(async ({ url, body }): Promise<AtomHttpResponse> => {
      requests.push(url);
      const payload = body as { params?: { arguments?: { node_id?: unknown } } };
      if (new URL(url).pathname !== "/mcp" || payload.params?.arguments?.node_id !== nodeId) {
        throw new Error(`Unexpected Atom MCP request ${url}`);
      }
      return {
        statusCode: 200,
        body: {
          result: {
            content: [{ text: JSON.stringify({ id: nodeId, parent_node_id: parentNodeId, card: { version: 12 } }) }],
          },
        },
      };
    }),
  };
  return { httpClient, requests };
}

describe("Atom skill body loader", () => {
  it("reads only the body node, strips exactly the generated header line, and reports version and child count", async () => {
    const nodeId = "77d4f29e-6251-47b5-96e4-3cc07485698c";
    const source = "# gpt-image-gen <!-- node:77d4f29e-6251-47b5-96e4-3cc07485698c card:8b89f3bd-4c02-430a-a329-ed1760425e4e -->\n\nBody text\n";
    const { httpClient, requests } = clientFor(nodeId, null, 0, source);
    const loaded = await loadAtomNodeBody({
      bodyNodeId: nodeId,
      nodeId: "catalog-node",
      atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "test" },
      logger: { warn: vi.fn() },
      httpClient,
    });

    expect(loaded).toEqual({ nodeId, markdown: "\nBody text\n", version: 12, childCount: 0 });
    expect(new URL(requests.find((url) => url.includes("/compile"))!).searchParams.get("depth")).toBe("0");
    expect(requests.some((url) => url.includes("/children"))).toBe(false);
    expect(requests.some((url) => url.includes("/outline"))).toBe(true);
    expect(requests).toContain("https://atom.test/mcp");
  });

  it("loads a catalog entry version independently from its skill body", async () => {
    const entryNodeId = "c4df7954-0f72-48a2-ae8d-74333ec32d51";
    const { httpClient } = clientFor(entryNodeId, null, 0, "# entry\nbody");
    await expect(loadAtomNodeMetadata({
      bodyNodeId: entryNodeId,
      nodeId: "catalog-node",
      atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "test" },
      logger: { warn: vi.fn() },
      httpClient,
    })).resolves.toEqual({ nodeId: entryNodeId, version: 12, parentNodeId: null });
  });

  it("parses the skill entry node id from its catalog heading", () => {
    const nodeId = "1d89817c-847c-4e93-8bb3-b690023bfa75";
    const entries = parseSkillCatalogMarkdown(
      `## gpt-image-gen <!-- node:${nodeId} -->\ndescription: image work\nbody_node_id: 77d4f29e-6251-47b5-96e4-3cc07485698c`,
      { warn: vi.fn() },
    );
    expect(entries).toMatchObject([{ name: "gpt-image-gen", nodeId }]);
  });
});
