import { describe, expect, it } from "vitest";

import {
  catalogLoadFailureKind,
  resolveInitialDefaultFolderId,
} from "./useInitialCatalogLoad";

describe("resolveInitialDefaultFolderId", () => {
  it("selects the stable claude folder id even when the display name changes", () => {
    expect(
      resolveInitialDefaultFolderId([
        { id: "amber-prod", name: "엠버 앤 블레이드 프로덕션" },
        { id: "claude", name: "사용자가 바꾼 클로드 폴더 이름" },
      ]),
    ).toBe("claude");
  });

  it("keeps the folder unselected instead of falling back to the first sorted folder", () => {
    expect(
      resolveInitialDefaultFolderId([
        { id: "amber-prod", name: "엠버 앤 블레이드 프로덕션" },
        { id: "other", name: "Other" },
      ]),
    ).toBeNull();
  });
});

describe("catalogLoadFailureKind", () => {
  it("separates authentication, forbidden, and generic failures", () => {
    expect(catalogLoadFailureKind(401)).toBe("authentication");
    expect(catalogLoadFailureKind(403)).toBe("forbidden");
    expect(catalogLoadFailureKind(500)).toBe("error");
  });
});
