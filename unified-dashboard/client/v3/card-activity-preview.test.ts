// @vitest-environment jsdom
import { expect, it } from "vitest";
import { cardActivityPreview } from "./card-activity-preview";

it("preserves markdown source and makes HTML a text-only preview without scripts or styles", () => {
  const markdown = "원문입니다.\n\n**요약하지 않습니다.**";
  expect(cardActivityPreview({format:"markdown",body:markdown})).toBe(markdown);
  const html = '<html><head><title>보고 제목</title><style>숨김</style></head><body><p>첫 &amp; 원문</p><p>둘째<br>줄</p><script>window.evil=1</script><img src="x" onerror="window.evil=1"></body></html>';
  expect(cardActivityPreview({format:"html",body:html})).toBe("첫 & 원문\n둘째\n줄");
  expect(document.querySelector("img")).toBeNull();
  expect((window as Window & {evil?:number}).evil).toBeUndefined();
  expect(cardActivityPreview({format:"html",body:"<ul><li>A</li><li>B</li></ul>"})).toBe("A\nB");
  expect(cardActivityPreview({format:"html",body:"<p> </p>"})).toBe("");
});
