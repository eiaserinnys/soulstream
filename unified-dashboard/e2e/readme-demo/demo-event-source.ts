import type { Page } from "@playwright/test";

/** Replay the routed SSE fixture without treating its finite body as a disconnect. */
export async function installDemoEventSource(page: Page) {
  await page.addInitScript(() => {
    class DemoEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private controller = new AbortController();

      constructor(url: string | URL) {
        super();
        this.url = new URL(url, location.href).href;
        void this.replay();
      }

      private async replay() {
        try {
          const response = await fetch(this.url, { signal: this.controller.signal });
          if (!response.ok) throw new Error(`Demo SSE HTTP ${response.status}`);
          const body = await response.text();
          if (this.readyState === this.CLOSED) return;
          this.readyState = this.OPEN;
          const opened = new Event("open");
          this.dispatchEvent(opened);
          this.onopen?.(opened);
          for (const frame of body.split("\n\n")) {
            if (this.readyState === this.CLOSED) return;
            const lines = frame.split("\n");
            const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
            if (!data) continue;
            const type = lines.find(line => line.startsWith("event: "))?.slice(7) ?? "message";
            const event = new MessageEvent(type, {
              data, lastEventId: lines.find(line => line.startsWith("id: "))?.slice(4) ?? "",
            });
            this.dispatchEvent(event);
            if (type === "message") this.onmessage?.(event);
          }
          // No EOF error: this demo represents a healthy, idle connection.
        } catch (error) {
          if (this.readyState === this.CLOSED) return;
          this.readyState = this.CLOSED;
          this.onerror?.(new Event("error"));
          throw error;
        }
      }

      close() {
        this.readyState = this.CLOSED;
        this.controller.abort();
      }
    }
    window.EventSource = DemoEventSource as unknown as typeof EventSource;
  });
}
