/** @vitest-environment jsdom */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./v3/V3DashboardLayout", () => ({
  V3DashboardLayout: () => <div data-testid="dashboard" />,
}));
vi.mock("./v3/ComponentsReviewLayout", () => ({
  ComponentsReviewLayout: () => <main data-testid="standalone-review" />,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

it("opens /components independently and restores the dashboard on navigation", async () => {
  window.history.replaceState(null, "", "/components");
  flushSync(() => root.render(<App />));
  await vi.waitFor(() => expect(container.querySelector('[data-testid="standalone-review"]')).not.toBeNull());
  expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();

  window.history.pushState(null, "", "/");
  flushSync(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await vi.waitFor(() => expect(container.querySelector('[data-testid="dashboard"]')).not.toBeNull());
  expect(container.querySelector('[data-testid="standalone-review"]')).toBeNull();
});
