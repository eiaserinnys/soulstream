import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DisclosureActionIcon } from "./DisclosureActionIcon";

describe("DisclosureActionIcon", () => {
  it("points down for the expand action and up for the collapse action", () => {
    const expand = renderToStaticMarkup(<DisclosureActionIcon expanded={false} />);
    const collapse = renderToStaticMarkup(<DisclosureActionIcon expanded />);

    expect(expand).toContain("lucide-chevron-down");
    expect(expand).not.toContain("lucide-chevron-up");
    expect(collapse).toContain("lucide-chevron-up");
    expect(collapse).not.toContain("lucide-chevron-down");
  });
});
