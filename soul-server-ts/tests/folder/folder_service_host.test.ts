import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderService } from "../../src/folder/folder_service.js";

const logger = { warn: vi.fn(), info: vi.fn() } as never;

afterEach(() => vi.unstubAllGlobals());

describe("FolderService host contract", () => {

  it("reads the card snapshot through the folder host", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ folder: { id: "folder-1" }, cards: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new FolderService({ orch: { baseUrl: "http://orch.local", headers: {} }, logger });
    expect(await service.getFolder("folder-1", { cardId: "card-1" })).toMatchObject({ cards: [] });
    expect(fetchMock).toHaveBeenCalledWith("http://orch.local/api/folders/host/get_folder", expect.objectContaining({ body: JSON.stringify({ folder_id: "folder-1", card_id: "card-1" }) }));
  });
});
