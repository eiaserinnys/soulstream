/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentSessionChatView } from "./PersistentSessionChatView";

const { getSession, setDisplaySettings } = vi.hoisted(() => ({
  getSession: vi.fn(),
  setDisplaySettings: vi.fn(),
}));

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    ChatView: () => React.createElement("div", { "data-testid": "chat-view" }),
    useDashboardStore: Object.assign((selector: (state: { setPersistentSessionDisplaySettings: typeof setDisplaySettings }) => unknown) => selector({ setPersistentSessionDisplaySettings: setDisplaySettings, persistentReports: {} } as any), {
      getState: () => ({ persistentReports: {}, setPersistentReport: vi.fn() }),
    }),
  };
});

vi.mock("../lib/persistent-sessions", () => ({
  createPersistentSessionsApi: () => ({ get: getSession }),
}));
vi.mock('@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider',()=>({PersistentReportProvider:({children}:{children:ReactNode})=>children}));
vi.mock('./PersistentReportDeck',()=>({PersistentReportDeck:({seat}:{seat?:{layout:unknown}})=><section data-testid="report-deck" data-bubble={Boolean(seat?.layout)}/> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PersistentSessionChatView", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("holds both displays until the active PAS settings response arrives", async () => {
    const settings = { show_generation_separator: true, show_jev_candidates: false };
    let resolveGet!: (value: unknown) => void;
    getSession.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));

    act(() => root?.render(<PersistentSessionChatView sessionId="pas-1" />));
    expect(host?.querySelector('[data-testid="chat-view"]')).not.toBeNull();
    expect(getSession).toHaveBeenCalledWith("pas-1");
    expect(setDisplaySettings).toHaveBeenNthCalledWith(1, "pas-1", null);

    await act(async () => {
      resolveGet({ session: { persistent: true, settings } });
      await Promise.resolve();
    });
    expect(setDisplaySettings).toHaveBeenNthCalledWith(2, "pas-1", settings);
  });

  it("keeps both displays hidden after a failed or non-PAS lookup", async () => {
    getSession.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      root?.render(<PersistentSessionChatView sessionId="pas-failed" />);
      await Promise.resolve();
    });
    expect(setDisplaySettings).toHaveBeenLastCalledWith("pas-failed", null);

    getSession.mockResolvedValueOnce({ session: { persistent: false, settings: { show_generation_separator: true, show_jev_candidates: true } } });
    await act(async () => {
      root?.render(<PersistentSessionChatView sessionId="ordinary" />);
      await Promise.resolve();
    });
    expect(setDisplaySettings).toHaveBeenLastCalledWith("ordinary", null);
  });
  it("renders immediately without fetching settings when the caller disables loading", async () => {
    act(() => root?.render(<PersistentSessionChatView sessionId="pas-inline" showReport loadDisplaySettings={false} />));
    expect(host?.querySelector('[data-testid="chat-view"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="report-deck"]')).not.toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(setDisplaySettings).not.toHaveBeenCalled();
  });
  it.each(['success','failure'])('defers only while settings load, then renders the available report after %s',async outcome=>{
    let resolve!: (value:unknown)=>void, reject!: (reason:unknown)=>void;
    getSession.mockReturnValue(new Promise((yes,no)=>{resolve=yes;reject=no;}));
    const seat={ready:true,target:null,body:null,layout:null};
    act(()=>root?.render(<PersistentSessionChatView sessionId="a" showReport reportSeat={seat}/>));
    expect(host?.querySelector('[data-testid="report-deck"]')).toBeNull();
    await act(async()=>{if(outcome==='failure')reject(new Error('offline'));else resolve({session:{persistent:true,settings:{show_character:true}}});});
    expect(host?.querySelector('[data-testid="report-deck"]')?.getAttribute('data-bubble')).toBe('false');
    getSession.mockReturnValue(new Promise(()=>{}));
    act(()=>root?.render(<PersistentSessionChatView sessionId="b" showReport reportSeat={seat}/>));
    expect(host?.querySelector('[data-testid="report-deck"]')).toBeNull();
  });
});
